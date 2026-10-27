# Spike: Container Apps Easy Auth (AllowAnonymous) on staging

Status: **runbook + design notes; live verification pending** (the agent that
wrote this has no Azure credentials, so the staging steps below are to be run
by someone with `az` access to `landrecon-staging`). Nothing here changes
deploy targets, workflows or secrets.

Goal: social-only sign-in (Google + Microsoft) via Container Apps built-in
authentication ("Easy Auth"), while the site stays fully usable anonymously,
and the Node sidecar can read the signed-in user's principal.

## Request path

```
client -> ACA ingress -> Easy Auth sidecar -> nginx :8000 -> /api/* -> Node sidecar (127.0.0.1)
```

Easy Auth runs in front of the app container, so nginx never sees a request
that bypassed it (ingress targets port 8000 only; the Node sidecar listens on
127.0.0.1). With `AllowAnonymous`, unauthenticated requests are passed through
unchanged; authenticated ones get identity headers injected.

## Headers the app receives (authenticated requests)

| Header | Content |
| --- | --- |
| `X-MS-CLIENT-PRINCIPAL` | base64 JSON: `auth_typ`, `name_typ`, `role_typ`, `claims[]` |
| `X-MS-CLIENT-PRINCIPAL-ID` | provider-scoped user id (stable key for Table Storage) |
| `X-MS-CLIENT-PRINCIPAL-NAME` | display name / email claim |
| `X-MS-CLIENT-PRINCIPAL-IDP` | `google` or `aad` |

nginx forwards request headers upstream by default, so a `proxy_pass` to the
sidecar needs no extra config. Do **not** add `proxy_set_header` rules that
reset these. Known constraint: the sidecar must treat these headers as
trusted only because Easy Auth is enabled on the app; if auth is ever turned
off the headers become client-spoofable. The sidecar (LAN-44) should
therefore also refuse to run in "trust principal headers" mode unless an env
flag (e.g. `EASY_AUTH_ENABLED=1`, set only where auth is configured) is set.

## Enabling on staging (run by a human with az access)

1. Create OAuth apps; redirect URIs (replace host):
   - Google: `https://<staging-fqdn>/.auth/login/google/callback`
   - Microsoft (Entra app, personal + work accounts):
     `https://<staging-fqdn>/.auth/login/aad/callback`
2. Store client secrets as Container App secrets (never in git):
   ```sh
   az containerapp secret set -n landrecon-staging -g LandRecon-RG \
     --secrets google-secret=<value> ms-secret=<value>
   ```
3. Configure providers and anonymous pass-through:
   ```sh
   az containerapp auth google update -n landrecon-staging -g LandRecon-RG \
     --client-id <id> --client-secret-name google-secret --yes
   az containerapp auth microsoft update -n landrecon-staging -g LandRecon-RG \
     --client-id <id> --client-secret-name ms-secret \
     --issuer https://login.microsoftonline.com/common/v2.0 --yes
   az containerapp auth update -n landrecon-staging -g LandRecon-RG \
     --unauthenticated-client-action AllowAnonymous \
     --redirect-provider google --enabled true --yes
   ```
   (`--redirect-provider` only matters for `RedirectToLoginPage`; with
   `AllowAnonymous` the SPA links to `/.auth/login/<provider>` itself.)
4. Optional: `--excluded-paths` is not needed with `AllowAnonymous`; crawlers
   hitting `/map` and `/og.png` pass through as anonymous.

## Verification checklist

Anonymous:
- `curl -si https://<fqdn>/` returns 200 (no redirect to a login page).
- `curl -si https://<fqdn>/og.png?address=x` returns 200.
- Spoof test: `curl -si -H 'X-MS-CLIENT-PRINCIPAL-ID: evil' https://<fqdn>/api/whoami`
  (once a debug echo exists) must **not** echo `evil`. Easy Auth is documented
  to overwrite these headers; confirm empirically and record the result below.

Signed in (browser):
- Visit `/.auth/login/google` and `/.auth/login/aad`; each completes and
  returns to the site.
- `GET /.auth/me` (same-origin, with cookie) returns the session JSON, usable
  by the SPA to show signed-in state.
- Temporarily log headers in the sidecar (or a throwaway `/api/whoami` route
  that echoes `X-MS-CLIENT-PRINCIPAL-ID` / `-IDP`) and confirm they arrive via
  nginx. Remove the debug route afterwards.
- Logout: `/.auth/logout?post_logout_redirect_uri=/`.

Record results here before LAN-44 starts:

| Check | Result |
| --- | --- |
| Anonymous 200 on `/`, `/map`, `/og.png` | _pending_ |
| Spoofed principal header ignored | _pending_ |
| Google login + headers reach sidecar | _pending_ |
| Microsoft login + headers reach sidecar | _pending_ |

## Notes for follow-up work (LAN-44 onward)

- Key users on `provider:X-MS-CLIENT-PRINCIPAL-ID` (`google:`/`aad:` prefix
  from `-IDP`), since ids are only unique per provider.
- Validate the principal in the sidecar (decode base64, require `auth_typ`
  and a non-empty id); anonymous requests simply lack the headers.
- Rate limits keyed on `$real_client_ip` in nginx remain the anonymous
  fallback; per-user limits belong in the sidecar.
- Auth cookies (`AppServiceAuthSession`) mean API calls from the SPA must be
  same-origin; the CSP already uses `connect-src 'self'`.
- Cost: Easy Auth is included in Container Apps pricing; no new paid
  third-party API usage (TomTom/Google Maps/Azure metered APIs) is introduced
  by this change. Google/Microsoft sign-in OAuth apps are free.
