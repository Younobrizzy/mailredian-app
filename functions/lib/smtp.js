import { connect } from "cloudflare:sockets";
import { ApiError } from "./http.js";

const encoder = new TextEncoder();
const SMTP_TIMEOUT_MS = 15_000;
const MAX_REPLY_BYTES = 64 * 1024;

class SmtpError extends Error {
  constructor(code, stage = "smtp") {
    super("SMTP operation failed.");
    this.name = "SmtpError";
    this.smtpCode = code;
    this.stage = stage;
  }
}

function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64Text(value) {
  return toBase64(encoder.encode(value));
}

function randomId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function encodeHeader(value) {
  if (/^[\x20-\x7E]*$/.test(value)) return value;

  // Split by Unicode characters so a multi-byte UTF-8 sequence is never cut
  // between encoded words. 42 source bytes keeps each encoded word <= 72 chars.
  const chunks = [];
  let current = "";
  for (const character of value) {
    if (encoder.encode(current + character).length > 42 && current) {
      chunks.push(current);
      current = "";
    }
    current += character;
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${base64Text(chunk)}?=`).join("\r\n ");
}

function encodeDisplayName(value) {
  if (!/^[\x20-\x7E]*$/.test(value)) return encodeHeader(value);
  if (/[(),:;<>@\[\]\\"]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  }
  return value;
}

function base64Lines(value) {
  const encoded = base64Text(value);
  const lines = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join("\r\n");
}

function formatAddressHeader(name, addresses) {
  const lines = [];
  let line = `${name}: `;
  for (let index = 0; index < addresses.length; index += 1) {
    const segment = `${index ? ", " : ""}${addresses[index]}`;
    if (line.length + segment.length > 78 && line.length > name.length + 2) {
      lines.push(line);
      line = ` ${addresses[index]}`;
    } else {
      line += segment;
    }
  }
  lines.push(line);
  return lines.join("\r\n");
}

function makeMessage(config, email) {
  const domain = config.fromEmail.slice(config.fromEmail.lastIndexOf("@") + 1);
  const isHtml = /<\s*[a-z][\s\S]*?>/i.test(email.message);
  const senderName = email.name || config.fromName;
  const headers = [
    `From: ${encodeDisplayName(senderName)} <${config.fromEmail}>`,
    formatAddressHeader("To", email.to),
    ...(email.cc.length ? [formatAddressHeader("Cc", email.cc)] : []),
    `Subject: ${encodeHeader(email.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomId()}@${domain}>`,
    "MIME-Version: 1.0",
    `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset="UTF-8"`,
    "Content-Transfer-Encoding: base64",
    ...(email.replyTo ? [`Reply-To: ${email.replyTo}`] : []),
  ];

  // BCC recipients are intentionally excluded from the message headers.
  const raw = `${headers.join("\r\n")}\r\n\r\n${base64Lines(email.message)}`;
  return { fromEmail: config.fromEmail, recipients: email.recipients, raw };
}

function createState(socket) {
  return {
    socket,
    reader: socket.readable.getReader(),
    writer: socket.writable.getWriter(),
    buffer: "",
    decoder: new TextDecoder(),
  };
}

async function withTimeout(promise, errorCode) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(errorCode)), SMTP_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function timedRead(reader) {
  return withTimeout(reader.read(), "SMTP_TIMEOUT");
}

async function readLine(state) {
  while (true) {
    const separator = state.buffer.indexOf("\r\n");
    if (separator !== -1) {
      const line = state.buffer.slice(0, separator);
      state.buffer = state.buffer.slice(separator + 2);
      return line;
    }

    const result = await timedRead(state.reader);
    if (result.done) throw new Error("SMTP_CLOSED");
    state.buffer += state.decoder.decode(result.value, { stream: true });
    if (encoder.encode(state.buffer).length > MAX_REPLY_BYTES) throw new Error("SMTP_REPLY_TOO_LARGE");
  }
}

async function readReply(state) {
  const first = await readLine(state);
  const match = /^(\d{3})([- ])/.exec(first);
  if (!match) throw new Error("SMTP_INVALID_REPLY");

  const code = Number(match[1]);
  const lines = [first];
  let line = first;
  while (line.startsWith(`${match[1]}-`)) {
    line = await readLine(state);
    lines.push(line);
    if (lines.length > 100) throw new Error("SMTP_TOO_MANY_REPLY_LINES");
  }
  if (!line.startsWith(`${match[1]} `)) throw new Error("SMTP_INCOMPLETE_REPLY");
  return { code, lines };
}

async function writeLine(state, value) {
  if (/[\r\n\0]/.test(value)) throw new Error("SMTP_UNSAFE_COMMAND");
  await state.writer.write(encoder.encode(`${value}\r\n`));
}

async function command(state, value, acceptedCodes) {
  await writeLine(state, value);
  const reply = await readReply(state);
  if (!acceptedCodes.includes(reply.code)) throw new SmtpError(reply.code, value.split(" ")[0]);
  return reply;
}

function capabilityLines(reply) {
  return reply.lines.map((line) => line.slice(4).trim().toUpperCase());
}

function supportsStartTls(reply) {
  return capabilityLines(reply).some((line) => /^STARTTLS(?:\s|$)/.test(line));
}

function authMechanisms(reply) {
  const line = capabilityLines(reply).find((item) => /^AUTH(?:=|\s)/.test(item));
  if (!line) return [];
  return line.replace(/^AUTH(?:=|\s)+/, "").split(/\s+/).filter(Boolean);
}

async function authenticate(state, reply, config) {
  const mechanisms = authMechanisms(reply);
  if (mechanisms.includes("LOGIN")) {
    await command(state, "AUTH LOGIN", [334]);
    await command(state, base64Text(config.username), [334]);
    await command(state, base64Text(config.password), [235]);
    return;
  }
  if (mechanisms.includes("PLAIN")) {
    const token = base64Text(`\0${config.username}\0${config.password}`);
    await command(state, `AUTH PLAIN ${token}`, [235]);
    return;
  }
  throw new SmtpError(504, "AUTH");
}

function releaseState(state) {
  try { state?.reader?.releaseLock(); } catch { /* best effort */ }
  try { state?.writer?.releaseLock(); } catch { /* best effort */ }
}

async function closeSocket(socket, state) {
  releaseState(state);
  try { await socket?.close(); } catch { /* best effort */ }
}

async function openSession(config) {
  let socket;
  let state;
  try {
    socket = connect(
      { hostname: config.host, port: config.port },
      {
        secureTransport: config.port === 465 ? "on" : "starttls",
        allowHalfOpen: false,
      },
    );
    await withTimeout(socket.opened, "SMTP_CONNECT_TIMEOUT");
    state = createState(socket);

    const greeting = await readReply(state);
    if (greeting.code !== 220) throw new SmtpError(greeting.code, "GREETING");

    let ehlo = await command(state, "EHLO mailredian.local", [250]);
    if (config.port === 587) {
      if (!supportsStartTls(ehlo)) throw new SmtpError(530, "STARTTLS_REQUIRED");
      await command(state, "STARTTLS", [220]);
      releaseState(state);
      socket = socket.startTls();
      await withTimeout(socket.opened, "SMTP_TLS_TIMEOUT");
      state = createState(socket);
      ehlo = await command(state, "EHLO mailredian.local", [250]);
    }

    await authenticate(state, ehlo, config);
    return { socket, state };
  } catch (error) {
    await closeSocket(socket, state);
    if (error instanceof SmtpError) {
      const status = error.stage === "AUTH" ? "SMTP_AUTH_FAILED" : "SMTP_CONNECTION_FAILED";
      throw new ApiError(502, status, "Email delivery failed.");
    }
    throw new ApiError(502, "SMTP_CONNECTION_FAILED", "Email delivery failed.");
  }
}

export async function sendEmail(config, email) {
  const message = makeMessage(config, email);
  const session = await openSession(config);
  try {
    const { state } = session;
    await command(state, `MAIL FROM:<${message.fromEmail}>`, [250]);
    for (const recipient of message.recipients) {
      await command(state, `RCPT TO:<${recipient}>`, [250, 251]);
    }
    await command(state, "DATA", [354]);

    const stuffed = message.raw
      .split("\r\n")
      .map((line) => (line.startsWith(".") ? `.${line}` : line))
      .join("\r\n");
    await state.writer.write(encoder.encode(`${stuffed}\r\n.\r\n`));
    const accepted = await readReply(state);
    if (accepted.code !== 250) throw new SmtpError(accepted.code, "DATA");
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(502, "SMTP_SEND_FAILED", "Email delivery failed.");
  } finally {
    try { await command(session.state, "QUIT", [221]); } catch { /* best effort */ }
    await closeSocket(session.socket, session.state);
  }
}
