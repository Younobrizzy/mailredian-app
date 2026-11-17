import { ApiError } from "./http.js";

const EMAIL_PATTERN = /^[^\s@<>(),;:\\"\[\]]+@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const MAX_MESSAGE_CHARS = 180_000;
const MAX_RECIPIENTS = 20;

function requiredText(value, field, maxLength) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
  }
  const result = value.trim();
  if (result.length > maxLength) {
    throw new ApiError(400, "VALIDATION_ERROR", `${field} is too long.`);
  }
  if (CONTROL_CHARS.test(result)) {
    throw new ApiError(400, "INVALID_HEADER", `${field} contains unsupported control characters.`);
  }
  return result;
}

export function validateEmail(value, field = "email") {
  const email = requiredText(value, field, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new ApiError(400, "INVALID_EMAIL", `${field} must contain a valid email address.`);
  }
  return email;
}

function addressList(value, field, required = false) {
  if (value === undefined || value === null) {
    if (required) throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
    return [];
  }

  const raw = Array.isArray(value) ? value : [value];
  if (raw.length === 0) {
    if (required) throw new ApiError(400, "VALIDATION_ERROR", `${field} is required.`);
    return [];
  }
  if (raw.length > MAX_RECIPIENTS) {
    throw new ApiError(400, "TOO_MANY_RECIPIENTS", `${field} supports at most ${MAX_RECIPIENTS} addresses.`);
  }
  return [...new Set(raw.map((item) => validateEmail(item, field)))];
}

export function validateEmailPayload(body, defaultRecipient) {
  if (body.from !== undefined || body.fromEmail !== undefined || body.fromName !== undefined || body.sender !== undefined) {
    throw new ApiError(400, "SENDER_IS_SERVER_MANAGED", "The sender is configured by the server.");
  }

  // If "to" is omitted, deliver to the configured default sender address.
  // An explicitly supplied but invalid/empty "to" remains a validation error.
  const to = body.to === undefined || body.to === null
    ? [validateEmail(defaultRecipient, "DEFAULT_FROM_EMAIL")]
    : addressList(body.to, "to", true);
  const cc = addressList(body.cc, "cc");
  const bcc = addressList(body.bcc, "bcc");
  const allRecipients = [...new Set([...to, ...cc, ...bcc].map((address) => address.toLowerCase()))];
  if (allRecipients.length > MAX_RECIPIENTS) {
    throw new ApiError(400, "TOO_MANY_RECIPIENTS", `A message can have at most ${MAX_RECIPIENTS} unique recipients.`);
  }

  const name = requiredText(body.name, "name", 100);

  const subject = requiredText(body.subject, "subject", 250);
  if (typeof body.message !== "string" || body.message.length === 0) {
    throw new ApiError(400, "MESSAGE_REQUIRED", "message is required and must be a non-empty string.");
  }
  if (body.message.length > MAX_MESSAGE_CHARS) {
    throw new ApiError(413, "MESSAGE_TOO_LARGE", "The email message is too large.");
  }

  const replyTo = body.replyTo === undefined || body.replyTo === null
    ? undefined
    : validateEmail(body.replyTo, "replyTo");

  // Notifications are opt-in. Missing notify is false; non-boolean values
  // are rejected instead of being interpreted as truthy/falsy strings.
  const notify = body.notify === undefined ? false : body.notify;
  if (typeof notify !== "boolean") {
    throw new ApiError(400, "INVALID_NOTIFY", "notify must be a boolean.");
  }

  return {
    to,
    cc,
    bcc,
    recipients: allRecipients,
    name,
    subject,
    message: body.message,
    replyTo,
    notify,
  };
}

function validateHost(value) {
  const host = requiredText(value, "DEFAULT_SMTP_HOST", 253).toLowerCase().replace(/\.$/, "");
  if (
    host.includes(":") || host.includes("/") || host.includes("@") ||
    host === "localhost" || host.endsWith(".local") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
  ) {
    throw new ApiError(503, "SMTP_CONFIGURATION_INVALID", "SMTP configuration is invalid.");
  }
  const labels = host.split(".");
  if (labels.length < 2 || labels.some((label) =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  )) {
    throw new ApiError(503, "SMTP_CONFIGURATION_INVALID", "SMTP configuration is invalid.");
  }
  return host;
}

export function getSmtpConfig(env) {
  const requiredNames = [
    "DEFAULT_SMTP_HOST",
    "DEFAULT_SMTP_PORT",
    "DEFAULT_SMTP_USERNAME",
    "DEFAULT_SMTP_PASSWORD",
    "DEFAULT_FROM_EMAIL",
  ];
  const missing = requiredNames.some((name) => typeof env?.[name] !== "string" || !env[name].trim());
  if (missing) {
    throw new ApiError(503, "SMTP_NOT_CONFIGURED", "SMTP settings are not fully configured.");
  }

  const portValue = String(env.DEFAULT_SMTP_PORT).trim();
  if (portValue !== "465" && portValue !== "587") {
    throw new ApiError(503, "SMTP_CONFIGURATION_INVALID", "SMTP port must be 465 or 587.");
  }

  const username = String(env.DEFAULT_SMTP_USERNAME);
  const password = String(env.DEFAULT_SMTP_PASSWORD);
  // AUTH LOGIN sends each credential as a single base64 SMTP line. Keeping
  // each source value below 300 bytes stays within SMTP's 512-octet line limit.
  if (new TextEncoder().encode(username).length > 300 || new TextEncoder().encode(password).length > 300) {
    throw new ApiError(503, "SMTP_CONFIGURATION_INVALID", "SMTP configuration is invalid.");
  }

  return {
    host: validateHost(env.DEFAULT_SMTP_HOST),
    port: Number(portValue),
    username,
    password,
    fromEmail: validateEmail(env.DEFAULT_FROM_EMAIL, "DEFAULT_FROM_EMAIL"),
    // Fallback display name when a payload does not include "name".
    fromName: "Notifications",
  };
}

export function isSmtpConfigured(env) {
  try {
    getSmtpConfig(env);
    return true;
  } catch {
    return false;
  }
}
