# Mailredian

A backend-only Cloudflare Pages Functions project. It exposes two HTTPS API routes and sends email through an external SMTP submission server using Cloudflare Workers' native `cloudflare:sockets` API.

No frontend, dashboard, Firebase, Firestore, database, service account, Node TCP library, runtime npm package, or application dependency is used.

## API routes

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/send` | Validate and send an email. |
| `GET` | `/api/health` | Check SMTP configuration without opening an SMTP connection or sending a test email. |

All other methods return `405 Method not allowed`.

### Send an email

Request header: `Content-Type: application/json`

```json
{
  "notify": true,
  "name": "Movara Notifications",
  "to": "customer@example.com",
  "subject": "Shipment Update",
  "message": "Your shipment has been updated."
}
```

The required fields are `name`, `subject`, and `message`. `name` is used as the sender display name; the sender email address is always `DEFAULT_FROM_EMAIL`. The payload cannot override the sender address with `from`, `fromEmail`, `fromName`, or `sender`.

- `notify` is optional and must be a JSON boolean. If omitted, it defaults to `false`. Strings such as `"true"` and `"false"` are rejected.
- `to` and `replyTo` are optional individually. Neither is required when `notify` is `false` or omitted.
- If neither `to` nor `replyTo` is supplied, the original email is sent only to `DEFAULT_FROM_EMAIL`. In this case, `notify` is ignored, even if it is `true`.
- If `to` is supplied, the original email is sent to `to`. When `notify` is `true`, a separate confirmation is sent to `DEFAULT_FROM_EMAIL`.
- If only `replyTo` is supplied, the original email is sent to `DEFAULT_FROM_EMAIL` and the `Reply-To` header is set to that address. When `notify` is `true`, a separate confirmation is sent to `replyTo`.
- If both `to` and `replyTo` are supplied, the original email is sent to `to`, with the `Reply-To` header set to `replyTo`. When `notify` is `true`, a separate confirmation is sent to `DEFAULT_FROM_EMAIL`.
- A confirmation is skipped if its target already received the original message. If the original message succeeds but the confirmation fails, the API still returns success for the original message to prevent accidental duplicate sends on client retries.
- `message` accepts plain text or HTML; HTML is detected when the message contains an HTML tag.
- `cc` and `bcc` remain supported as optional additional recipients. They accept one address or an array, with a maximum of 20 unique recipients across To, CC, and BCC. BCC recipients are not exposed in message headers.
- Confirmation emails use the same `name` display name and `DEFAULT_FROM_EMAIL` sender address as the original email.

Successful response:

```json
{
  "success": true,
  "message": "Email sent successfully."
}
```

Failed delivery response:

```json
{
  "success": false,
  "message": "Email delivery failed."
}
```

Every failed `/api/send` request returns exactly the same JSON body shown above, including validation errors, rate limits, configuration errors, and SMTP delivery failures. The HTTP status code still distinguishes the failure category (`4xx` for request/rate-limit errors, `503` for invalid or missing SMTP configuration, and `502` for SMTP delivery failures). No internal SMTP details or credentials are exposed.

### Health check

Configured:

```json
{
  "system": "active",
  "smtp": "configured"
}
```

Not configured:

```json
{
  "system": "active",
  "smtp": "not_configured"
}
```

The health route checks that all five required variables exist and have valid formats. It does not connect to the SMTP server or verify the password.

## Cloudflare environment variables

Configure these five variables in **Workers & Pages → your Pages project → Settings → Variables and Secrets**. These are the only environment variables required by this project. The sender display name is supplied in the required `name` payload field.

| Variable | Description |
|---|---|
| `DEFAULT_SMTP_HOST` | SMTP server hostname, such as `smtp.example.com`. |
| `DEFAULT_SMTP_PORT` | `465` or `587`. |
| `DEFAULT_SMTP_USERNAME` | SMTP authentication username. |
| `DEFAULT_SMTP_PASSWORD` | SMTP authentication password. Store as a Cloudflare secret. |
| `DEFAULT_FROM_EMAIL` | Default sender email address. |

Only ports **465** and **587** are supported:

- **465:** implicit TLS from the start of the connection.
- **587:** connect, require STARTTLS, upgrade to TLS, then authenticate.

Port 25 is not supported by Cloudflare Workers TCP sockets.

## Cloudflare Pages deployment

The `functions/` directory must be at the Pages project root, alongside `public/` and `wrangler.toml`.

For Git integration, configure:

| Pages setting | Value |
|---|---|
| Framework preset | `None` |
| Root directory | The directory containing `functions/`, `public/`, and `wrangler.toml` (repository root if these files are at the top level) |
| Build command | `exit 0` |
| Build output directory | `public` |

Do not set the output directory to `functions/public`. Do not set the root directory to a parent or child folder that separates `functions/` from `wrangler.toml`.

The project has no build step and no npm dependencies. The `public/` folder contains only `_routes.json`, which tells Pages to run Functions only for `/api/*` requests.

After deployment, test:

```text
https://YOUR-PROJECT.pages.dev/api/health
```

### Optional local development or CLI deployment

Install Node.js 20+ and run Wrangler through `npx` (Wrangler is a deployment tool only; it is not an application dependency):

```bash
npx wrangler@4 pages dev ./public --config ./wrangler.toml
```

For local secrets, create a `.dev.vars` file in the project root containing the same five variable names and your local values. Do not commit this file.

Deploy from the project root:

```bash
npx wrangler@4 login
npx wrangler@4 pages deploy ./public --project-name mailredian --config ./wrangler.toml
```

If your existing Cloudflare Pages project has a different name, replace `mailredian` with that exact project name.

## Security

**The five-variable-only requirement does not provide caller authentication.** Without an API key, authorization secret, or authenticated identity, anyone who can reach the deployed URL may attempt to send email. CORS is not authentication.

The code includes payload validation, header-injection prevention, a request-size limit, a 20-recipient limit, safe error responses, and a best-effort in-memory limiter of 10 requests per minute per client IP. That limiter is per running isolate and is not a global or persistent abuse-control system.

Before making the endpoint public, configure Cloudflare edge protection, such as a WAF rate-limiting rule for `POST /api/send`. Restrict callers by IP or protect the route with Cloudflare Access where practical.

## Project structure

```text
mailredian/
├── functions/
│   ├── api/
│   │   ├── health.js
│   │   └── send.js
│   └── lib/
│       ├── http.js
│       ├── rate-limit.js
│       ├── smtp.js
│       └── validation.js
├── public/
│   └── _routes.json
├── .gitignore
├── README.md
└── wrangler.toml
```

## Notes

- This is an HTTPS email API, not an SMTP server.
- The SMTP provider must permit authenticated submission from Cloudflare's outbound network and support TLS on port 465 or STARTTLS on port 587.
- A `configured` health response confirms configuration format only; it does not prove that the SMTP server is reachable or that authentication succeeds.
