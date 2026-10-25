# Auth setup checklist (board)

Everything here needs your identity (accounts, DNS). Do it once, in order.
Nothing in this list is a secret except where marked **SECRET**; secrets go
only into the dashboard named, never into GitHub, chat or comments.

Placeholders: `<PROD_URL>` = production origin with no trailing slash (e.g.
`https://landrecon.example.com`); `<REF>` = the Supabase project reference.

## What the Engineer needs back (send these, nothing else)

1. Supabase **Project URL** (`https://<REF>.supabase.co`), not secret
2. Supabase **publishable (anon) key**, not secret
3. **Sender address** for sign-in emails (e.g. `login@<your-domain>`)
4. Confirmation of `<PROD_URL>`

Never send the service_role key, Google client secret or Resend API key.

## 1. Supabase project (Free plan)

1. Sign up at https://supabase.com, create an organisation (Free plan).
2. New project: name `landrecon`, region **East US (N. Virginia)**, strong DB password (store in your password manager).
3. Settings > API: copy Project URL and the publishable/anon key.
4. SQL Editor: paste and run `supabase/migrations/20261025000000_auth_saved_items.sql`.
5. Authentication > URL Configuration:
   - Site URL: `<PROD_URL>`
   - Redirect URLs (exact, no wildcards):
     - `<PROD_URL>/auth/callback`
     - `http://localhost:5173/auth/callback`
6. Authentication > Sign In / Providers:
   - Email: enabled, **Confirm email** on, **Secure email change** on. Disable passwords where offered (we only use email OTP / magic link).
   - Email OTP expiry: 900 seconds (15 min) or less.
   - Allow new users to sign up: on.
7. Authentication > Rate Limits: keep emails-per-hour low (e.g. 10) and enable CAPTCHA (Authentication > Attack Protection, hCaptcha or Turnstile) and tell the Engineer which one and the site key.
8. Authentication > Email Templates (Magic Link): include the `{{ .Token }}` 6-digit code in the body so link scanners cannot consume the only credential.

## 2. Google OAuth

1. https://console.cloud.google.com > create project `landrecon`.
2. APIs & Services > OAuth consent screen: External, app name `LandRecon`, support email and developer contact = yours, authorised domain = your domain. Scopes: only `openid`, `email`, `profile`. Privacy policy link: `<PROD_URL>/privacy` (after PR 5 ships).
3. Credentials > Create credentials > OAuth client ID > Web application:
   - Authorised JavaScript origins: `<PROD_URL>`
   - Authorised redirect URIs: `https://<REF>.supabase.co/auth/v1/callback`
4. Copy Client ID and **SECRET** into Supabase > Authentication > Providers > Google, enable it, save.
5. Publish the consent screen (In production) when ready for real users.

## 3. Resend (SMTP) and DNS

1. Sign up at https://resend.com (Free plan, 100 emails/day).
2. Domains > Add domain (your sender domain, ideally a subdomain such as `mail.<your-domain>`). Add the DNS records Resend shows:
   - SPF: TXT on `send.<domain>` as shown by Resend (typically `v=spf1 include:amazonses.com ~all`)
   - DKIM: TXT `resend._domainkey.<domain>` with the value Resend gives
   - MX on `send.<domain>` as shown by Resend
   - DMARC (recommended): TXT `_dmarc.<domain>` = `v=DMARC1; p=none; rua=mailto:<your address>`
3. Wait for Resend to show Verified.
4. API Keys > create key with "Sending access" only. **SECRET**.
5. Supabase > Authentication > SMTP Settings > enable custom SMTP:
   - Host `smtp.resend.com`, port `465`
   - Username `resend`, password = the Resend API key
   - Sender email = the address from item 3 above, sender name `LandRecon`

## 4. GitHub Actions variables (not secrets; public by design)

Repo > Settings > Secrets and variables > Actions > Variables:

- `SUPABASE_URL` = Project URL
- `SUPABASE_ANON_KEY` = publishable key

These feed the `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` build args (PR 0).
The CSP in `nginx.conf` currently allows `https://*.supabase.co`; once `<REF>` is known, narrow it to `https://<REF>.supabase.co`.

## 5. Account deletion Edge Function (after PR 5)

1. Install the Supabase CLI, `supabase login`, `supabase link --project-ref <REF>`.
2. `supabase functions deploy delete-account`. The service role key is injected by Supabase automatically; do not copy it anywhere.

## 6. Verify

- Sign in with Google and with an emailed code on Gmail and Outlook.
- Browser console shows no CSP violations.
- Run `supabase/tests/rls.sql` against a scratch DB (or ask the Engineer to).
