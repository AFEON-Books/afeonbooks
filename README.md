# AFEON Books

AFEON Books is a TypeScript monorepo for the AFEON Books storefront, admin dashboard, point-of-sale tools, and Express API.

## Stack

- React and Vite for the storefront and admin applications
- Express 5 for the API
- PostgreSQL with Drizzle ORM
- TypeScript, Zod, TanStack Query, and pnpm workspaces
- Cloudflare Worker routing for the production site and API

## Repository Layout

| Path | Purpose |
| --- | --- |
| `artifacts/site` | Public storefront and customer account pages |
| `artifacts/admin` | Admin editor, order management, POS, and dev tools |
| `artifacts/api-server` | Express API server |
| `lib/db` | Drizzle database package and schema |
| `lib/api-spec` | OpenAPI specification and code generation |
| `lib/api-client-react` | Generated React API client |
| `worker.js` | Production Cloudflare routing and API forwarding |

## Requirements

- Node.js 24
- pnpm
- PostgreSQL

Install dependencies from the repository root:

```bash
pnpm install
```

The workspace enforces a 24-hour minimum package release age and only permits approved dependency build scripts. Do not disable these protections without a specific security review.

Public source exports exclude environment files, backups, database dumps, data exports, key files, and archives. Keep private operational data out of public asset directories.

## Development

Run the API with a required port and database connection:

```bash
PORT=5000 DATABASE_URL=postgres://user:password@localhost:5432/afeonbooks \
	pnpm --filter @workspace/api-server run dev
```

Run the storefront in another terminal:

```bash
pnpm --filter @workspace/site run dev
```

Run the admin application in another terminal:

```bash
API_URL=https://api.afeonbooks.com \
	pnpm --filter @workspace/admin run dev
```

The admin Vite server proxies `/api` requests to `API_URL`. For a local API, set `API_URL=http://localhost:5000` instead. The site and admin Vite ports can be overridden with `PORT`.

## Common Commands

```bash
pnpm run typecheck
pnpm run build
pnpm --filter @workspace/api-server run typecheck
pnpm --filter @workspace/site run typecheck
pnpm --filter @workspace/admin run typecheck
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/db run push
```

`db run push` is intended for development databases. Review schema changes before applying them to production.

For the marketing tables, apply [`lib/db/migrations/0001_marketing.sql`](./lib/db/migrations/0001_marketing.sql) to the production API database before using the marketing admin page. The API returns a server error if `banners` or `promo_codes` has not been created.

Before deploying the guest-order privacy changes, apply [`lib/db/migrations/0002_order_access_tokens.sql`](./lib/db/migrations/0002_order_access_tokens.sql). Guest order links use expiring access tokens; staff can revoke guest access with `DELETE /api/orders/:id/access-tokens`. Existing guest links without tokens require account sign-in.

Before deploying the staff authentication changes, apply [`lib/db/migrations/0003_staff_authentication.sql`](./lib/db/migrations/0003_staff_authentication.sql) to add one-time-code attempt tracking and remove the insecure shared `site_content.admin_pin`. Apply [`lib/db/migrations/0004_remove_staff_pins.sql`](./lib/db/migrations/0004_remove_staff_pins.sql) to remove the deprecated per-staff PIN data.

## Production API

The canonical API origin is:

```text
https://api.afeonbooks.com
```

The production Cloudflare Worker forwards `/api/*` requests from the main site to that origin. The previous Render API hostname should not be used.

## Private Mail System

The mailbox app is served at `https://mailsystem.afeonbooks.com` by the Cloudflare Worker. Cloudflare Access with GitHub is required in addition to a matching, verified AFEON staff or admin account. Each staff member or admin must sign in to Zoho and authorize the mailbox from their own AFEON session; credentials are encrypted in PostgreSQL and bound to that person's session. Locking or signing out deletes that session's stored credential.

Use `ZOHO_MAILBOX_` variables for mailbox OAuth and configuration; `ZOHO_` variables without that prefix remain for transactional email sending. Existing deployments can continue using the previous names as fallbacks, but should migrate to the mailbox-prefixed names.

- `ZOHO_MAILBOX_CLIENT_ID` and `ZOHO_MAILBOX_CLIENT_SECRET` from the mailbox Zoho OAuth client.
- `ZOHO_MAILBOX_OAUTH_REDIRECT_URI=https://api.afeonbooks.com/api/mail/auth/callback`, registered exactly in the Zoho OAuth client.
- `ZOHO_MAILBOX_ACCOUNTS_URL` and `ZOHO_MAILBOX_API_URL` for the Zoho data center that hosts the mailbox (defaults target the `.com` data center).
- `ZOHO_MAILBOX_ACCOUNT_ID` or `ZOHO_MAILBOX_AUTHENTICATED_USER` to select the intended mailbox when the Zoho account has multiple mailboxes.
- `MAIL_TOKEN_ENCRYPTION_KEY`, a base64-encoded random 32-byte key. Generate it with `openssl rand -base64 32`; keep it only in Render's secret environment and back it up securely because losing it prevents decrypting saved mailbox credentials.

Mailbox OAuth credentials and URLs retain fallbacks for existing deployments. Mailbox account selection uses only `ZOHO_MAILBOX_ACCOUNT_ID` or `ZOHO_MAILBOX_AUTHENTICATED_USER`; it does not read `ZOHO_MAIL_ACCOUNT_ID` or `ZOHO_MAIL_AUTHENTICATED_USER`, which remain dedicated to transactional email sending.

The first authorization requests Zoho account/folder read and message read/create/update/delete scopes. The app implements inbox/folder browsing, search, message reading, compose/reply, read/unread, archive, flag, move, and trash actions. It does not yet implement attachment upload/download, drafts, contacts, calendar, or Zoho account settings. End-to-end use also requires deploying the Worker custom-domain route and registering/validating the OAuth redirect with Zoho.

## Admin and Source Dashboard Access

The Worker fails closed on `/admin/*`, the entire `mailsystem.afeonbooks.com` host, and the source dashboard routes unless it receives a valid Cloudflare Access JWT. The API independently verifies the JWT for staff/admin operations and requires its verified email to match the signed-in, verified AFEON staff account. API role checks remain in force; staff or admin roles are required for the admin and mailbox applications.

Configure these items in Cloudflare Zero Trust before deploying:

1. Add GitHub as an identity provider using Cloudflare's current [GitHub IdP instructions](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/github/). Store the GitHub OAuth client secret only in Cloudflare.
2. Create Access applications for `afeonbooks.com/admin*`, `mailsystem.afeonbooks.com/*`, and the source dashboard routes on `source.afeonbooks.com` (`/`, `/source*`, `/infra*`). Use an allow policy restricted to members of the GitHub organization [AFEON-Books](https://github.com/AFEON-Books); do not use an “Everyone” policy.
3. Configure `CF_ACCESS_TEAM_DOMAIN` on the API service as the HTTPS Cloudflare Access team domain. Configure `CF_ACCESS_AUDS` as a comma-separated list of the Access application audience tags for all three applications. Keep this configuration synchronized when applications are recreated.
4. Require GitHub two-factor authentication for organization members.
5. Add `AUTH_CODE_PEPPER` as a random secret environment variable on the API service. Do not commit it. The API uses it to HMAC email login codes and rate-limit keys.
6. Apply migrations 0003 and 0004 before deploying the API. Migration 0004 removes the deprecated staff PIN data; staff/admin access is based on the verified account role and Cloudflare Access identity.

Customer authentication remains public and separate from Cloudflare Access. The sign-in page starts with email lookup. Existing verified accounts receive a five-digit sign-in code (10-minute expiry, at most three sends per 15 minutes and five code attempts); password sign-in remains available. Unknown addresses are offered signup and the existing email-verification flow. Because the requested flow discloses whether an email has an account, the lookup is protected by Turnstile and database-backed rate limits but still permits account enumeration.

For a fresh database, set `INITIAL_ADMIN_EMAIL` to the owner's verified email before account registration. Only that address can become the initial administrator; public signup no longer grants admin access to whichever person registers first.

The admin-only development testing API is:

```http
POST /api/dev-testing/start
POST /api/dev-testing/stop
GET  /api/dev-testing/status
```

It snapshots orders, order items, and products, then restores them when the ten-minute session ends or is stopped.

## Loyalty Points

Checkout displays estimated points, but points are not credited when an order is first placed. The API awards points when staff changes the order status to `delivered` or `completed`.

The current award formula is:

```text
floor(total in cents / 100) * 50 points
```

Customers can view their balance and transactions through `GET /api/auth/loyalty` while signed in.

## API Code Generation

When the OpenAPI contract changes, regenerate the client and Zod types:

```bash
pnpm --filter @workspace/api-spec run codegen
```

Generated files live under `lib/api-client-react/src/generated` and `lib/api-zod/src/generated`.
