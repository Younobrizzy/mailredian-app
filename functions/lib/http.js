export class ApiError extends Error {
  constructor(status, code, publicMessage) {
    super(publicMessage);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export function json(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  return new Response(JSON.stringify(data), { status, headers });
}

export async function readJson(request, maxBytes = 256 * 1024) {
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new ApiError(415, "JSON_REQUIRED", "Content-Type must be application/json.");
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.");
  }

  let bytes;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    throw new ApiError(400, "INVALID_BODY", "The request body could not be read.");
  }
  if (bytes.byteLength > maxBytes) {
    throw new ApiError(413, "BODY_TOO_LARGE", "The request body is too large.");
  }

  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
    return value;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be a valid JSON object.");
  }
}

export function methodNotAllowed(allowed) {
  return json(
    { success: false, message: "Method not allowed." },
    405,
    { Allow: allowed },
  );
}

export function errorResponse(error) {
  if (error instanceof ApiError) {
    return json({ success: false, message: error.publicMessage }, error.status);
  }

  // Never log request bodies, SMTP replies, host credentials, or connection
  // objects. Unexpected errors are deliberately reduced to a generic response.
  return json({ success: false, message: "Email delivery failed." }, 500);
}
