import { json, methodNotAllowed } from "../lib/http.js";
import { isSmtpConfigured } from "../lib/validation.js";

export async function onRequest({ request, env }) {
  if (request.method !== "GET") {
    return methodNotAllowed("GET");
  }

  // Use the same five-variable SMTP configuration check as /api/send.
  return json(
    {
      system: "active",
      smtp: isSmtpConfigured(env) ? "configured" : "not_configured",
    },
    200,
    {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "Pragma": "no-cache",
      "X-Health-Version": "smtp-health-v6",
    },
  );
}
