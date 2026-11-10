# Arcade Store

Phase 1 is a mobile-first storefront built with plain HTML, CSS, and JavaScript modules. The browser app can run in local preview mode without sending account data. A Supabase project is required for real accounts, listings, orders, payment, owner access, and email delivery.

The supplied images were used as design references only. The UI uses an original Arcade Store mark and generated CSS artwork placeholders. Owners can upload the three game images through the admin console after Supabase Storage is connected.

## Local preview

Requirements: Node.js 22 or newer.

```powershell
npm run serve
```

Open `http://127.0.0.1:4173`. In preview mode, create an account with any valid display name, email, and password, then enter `000000` on the OTP screen. Preview mode stores demo state only in memory and does not call Supabase or Flutterwave. Checkout remains a local preview; it does not transfer money.

Run the local suite:

```powershell
npm test
```

## Supabase setup

These steps require access to the Supabase account where the new organization should live. The project has not been provisioned from this workspace.

1. Create a Supabase organization on the free tier, then create a project in the desired region. Save the database password in a password manager; it is not needed by the browser app.
2. Install the Supabase CLI, authenticate with `supabase login`, then link this folder with `supabase link --project-ref YOUR_PROJECT_REF`.
3. Apply the database schema and scheduled expiry migrations with `supabase db push`. This enables RLS, reservation/payment state transitions, feature flags, rate limits, and the one-minute expiry jobs.
4. Configure Google OAuth. In Google Cloud Console, create a web OAuth client, set the authorized redirect URI to `https://yuejcomfxczdbjlgxcsw.supabase.co/auth/v1/callback`, and copy its client ID and secret into **Supabase → Authentication → Sign In / Providers → Google**. Keep the Google client secret in Supabase only. In Supabase URL Configuration, set the Site URL to your eventual GitHub Pages URL and allow that URL plus both local preview URLs (`http://localhost:4173/**` and `http://127.0.0.1:4173/**`). In Google Cloud, add the local and hosted site origins as authorized JavaScript origins. Google may require your OAuth consent screen to be in testing mode with your account listed as a test user until you publish it.
5. Apply `supabase/migrations/202611060003_google_oauth_profiles.sql` in the Supabase SQL Editor (or deploy it with the CLI). This updates the profile trigger so a first-time Google user gets a unique Arcade Store username. New account creation in the app uses Google and does not send email codes. Existing email/password accounts can still sign in; password reset still needs email delivery.
6. Create the owner user with Google sign-in. In the Supabase dashboard, set that user’s **app metadata** role to `owner`, then sign out and back in so the new role enters the JWT. Never set roles through user-editable metadata.
7. Add the required function secrets (names below) in Supabase Edge Function settings. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are available from the project API settings. Generate a random `CREDENTIALS_ENCRYPTION_KEY` of at least 32 characters and keep a secure backup; losing it makes encrypted account credentials unrecoverable.
8. Deploy the Edge Functions with `supabase functions deploy --project-ref YOUR_PROJECT_REF`. Set `FLW_MODE=test` and use only the Flutterwave test secret key at first. Leave `payouts` and `live_payments` off until their separate safeguards have been reviewed.
9. Copy the project URL and anon/publishable key into `config.js`, set `demoMode: false`, and keep every service-role, Google OAuth secret, Flutterwave secret, encryption key, and transfer setting in Supabase settings/secrets only.
10. Verify Google sign-in, RLS, owner role, reservation expiry, test checkout, payment verification, and paid-order credential release against the project before enabling any production payment flag.

The `.env.example` file contains names only. Supabase secrets used by functions are:

| Name | Use |
| --- | --- |
| `SUPABASE_URL` | Project API URL (Supabase also provides this automatically to functions). |
| `SUPABASE_ANON_KEY` | Public API key used for Auth verification by server functions; browser copy belongs in `config.js`. |
| `SUPABASE_SERVICE_ROLE_KEY` | Privileged database access for Edge Functions only. |
| `SUPABASE_DB_URL` | Direct database connection string for CLI/administrative tooling; never put in browser code. |
| `SITE_URL` | Hosted application URL used in auth redirects. |
| `OWNER_USER_ID` | Auth UUID of the owner; checked alongside the server-set app metadata role. |
| `FLW_MODE` | `test` by default; set `live` only after a separate live-payment review. |
| `FLW_TEST_SECRET_KEY` | Flutterwave test secret key, server side only. |
| `FLW_LIVE_SECRET_KEY` | Flutterwave live secret key, server side only. |
| `CREDENTIALS_ENCRYPTION_KEY` | Base64 encoded 32-byte AES key for encrypted credentials and bank account numbers. |
| `TRANSFER_EGRESS_IP` | IP allowlist value checked before any payout transfer or status lookup. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD` | Optional future SMTP configuration; Supabase built-in email works before SMTP is configured. |

Supabase automatically injects its URL and service key into Edge Functions. The explicit names are kept in `.env.example` as a deployment checklist; do not commit values there.

## GitHub Pages setup

1. Create a private or public GitHub repository for this folder and add the files locally. Nothing has been pushed from this build.
2. Set `config.js` to the project URL and anon/publishable key, and set `demoMode: false`. These browser values are public by design; RLS and Edge Functions must enforce all access.
3. The deployed Pages URL is `https://arcadestoreonep.github.io/ARCADESTORE-APP/`. Set it as the Supabase Auth Site URL and add it to the Auth redirect allowlist alongside both local preview URLs. The matching values are recorded in `supabase/config.toml` for local Supabase development.
4. In GitHub repository settings, choose **Pages → Build and deployment → GitHub Actions**. The included `.github/workflows/pages.yml` deploys the repository root when `main` is pushed or the workflow is manually dispatched.
5. Add the final GitHub Pages URL to Supabase Auth redirect URLs and run a signup/sign-in smoke check on the published site.

No GitHub push or deployment has been performed.

## Files

- `index.html` — app document and module entry point.
- `config.js` — public Supabase URL/key and demo-mode switch; no server secrets.
- `styles.css` — dark glass, lime-accented responsive design and motion settings.
- `src/main.js` — buyer screens, local preview, auth, cart, orders, settings, and owner console UI.
- `assets/arcade-mark.svg` — original Arcade Store placeholder mark.
- `.env.example` — environment and secret names only.
- `supabase/config.toml` — local Supabase project and auth redirect settings.
- `supabase/migrations/202611060001_initial.sql` — schema, RLS, feature flags, data rules, and server-side state functions.
- `supabase/migrations/202611060002_scheduled_expiry.sql` — one-minute reservation and payment-hold expiry jobs.
- `supabase/migrations/202611060003_google_oauth_profiles.sql` — profile trigger support for first-time Google OAuth accounts.
- `supabase/functions/_shared/core.mjs` — payment, payout, role, expiry, and encryption rules.
- `supabase/functions/_shared/operations.mjs` — dependency-injected transaction operations used by tests.
- `supabase/functions/_shared/server.ts` — Supabase Auth/service clients, rate limiting, Flutterwave REST, and HTTP helpers.
- `supabase/functions/*/index.ts` — Auth, reservation, checkout, reconciliation, admin, credential release, seller, and payout endpoints.
- `tests/logic.test.mjs` — deterministic unit and mocked-operation tests; no live provider calls.
- `tools/serve.mjs` — small local static preview server.
- `.github/workflows/pages.yml` — GitHub Pages deployment workflow.
- `package.json` — Node engine and local preview/test commands.

## Test status and limits

`npm test` covers unit and mocked-operation cases for ledger balance, expiry, default-off flags, app metadata roles, reservations, deletion, duplicate and mismatched settlement, encryption, vendor subaccount routing, checkout operations, verified and late payment reconciliation, and payout name/balance/unknown-status rules. It does not make real Supabase or Flutterwave calls.

Browser walkthrough completed on the local preview: landing page, blank signup validation, preview OTP, marketplace, adding an account to the cart, and live reservation countdown. The layout was inspected at a 1280px desktop render and a 390 CSS-pixel responsive viewport. A real owner session and feature-flag changes cannot be tested until a Supabase project exists and its owner role is configured.

Blocked pending Supabase provisioning and credentials: deployed Edge Function integration checks, RLS checks against Postgres, owner-console toggle verification, Google OAuth provider setup, Flutterwave test-card checkout/verification, and published GitHub Pages checks. Payout transfers were not called; payouts are disabled by default and require a verified server egress IP. Live payments and payouts must remain off until test-mode verification is complete.

## Choices made

- Used text-led original game tiles and the original store mark until the owner uploads authorized game art.
- Kept reservations at 48 hours and the payment hold at 20 minutes, following the product brief.
- Kept the UI in local preview mode by default because no Supabase project is connected.
- Kept Flutterwave test mode as the default, with live payments and payouts disabled.
