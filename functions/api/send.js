import { ApiError, json, readJson } from "../lib/http.js";
import { allowRequest } from "../lib/rate-limit.js";
import { sendEmail } from "../lib/smtp.js";
import { getSmtpConfig, validateEmailPayload } from "../lib/validation.js";

const FAILURE_BODY = {
  success: false,
  message: "Email delivery failed.",
};

function failure(status, extraHeaders = {}) {
  return json(FAILURE_BODY, status, extraHeaders);
}

function makeNotification(email, notificationAddress) {
  const recipients = email.to.join(", ");
  return {
    to: [notificationAddress],
    cc: [],
    bcc: [],
    recipients: [notificationAddress],
    name: email.name,
    subject: "Email sent successfully",
    message: [
      "Your message was sent successfully.",
      "",
      `Recipient: ${recipients}`,
      `Subject: ${email.subject}`,
    ].join("\n"),
    replyTo: undefined,
  };
}

export async function onRequest({ request, env }) {
  if (request.method !== "POST") {
    return failure(405, { Allow: "POST" });
  }

  try {
    const ipAddress = request.headers.get("cf-connecting-ip") || "unknown";
    const rate = allowRequest(ipAddress);

    if (!rate.allowed) {
      return failure(429, { "Retry-After": String(rate.retryAfter) });
    }

    const body = await readJson(request);
    const config = getSmtpConfig(env);
    const hasExplicitTo = body.to !== undefined && body.to !== null;
    const hasExplicitReplyTo = body.replyTo !== undefined && body.replyTo !== null;
    const email = validateEmailPayload(body, config.fromEmail);

    // The original message goes to "to" when supplied. Otherwise validation
    // routes it to DEFAULT_FROM_EMAIL.
    await sendEmail(config, email);

    // Notifications are opt-in. With an explicit "to", notify DEFAULT_FROM_EMAIL.
    // Without "to", notify replyTo (if supplied), because DEFAULT_FROM_EMAIL
    // already received the original message.
    const notificationAddress = hasExplicitTo
      ? config.fromEmail
      : email.replyTo;

    const notificationMailboxAlreadyReceivedMessage = notificationAddress
      && email.recipients.some(
        (recipient) => recipient.toLowerCase() === notificationAddress.toLowerCase(),
      );

    // Without either recipient field, ignore notify and send only the original
    // message to DEFAULT_FROM_EMAIL.
    const notificationIsSupported = hasExplicitTo || hasExplicitReplyTo;

    if (notificationIsSupported && email.notify && notificationAddress && !notificationMailboxAlreadyReceivedMessage) {
      try {
        const notification = makeNotification(email, notificationAddress);
        await sendEmail(config, notification);
      } catch {
        // The original message was already accepted. Do not return failure
        // and risk a client retry sending the original message twice.
      }
    }

    return json(
      { success: true, message: "Email sent successfully." },
      200,
    );
  } catch (error) {
    // Preserve useful HTTP status codes while keeping the response body
    // identical for every failure. Never return SMTP details or credentials.
    const status = error instanceof ApiError
      ? error.status
      : 502;

    return failure(status);
  }
}
