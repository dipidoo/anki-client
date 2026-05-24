# oauth-proxy — OCF deploy

Tiny PHP script that exchanges a GitHub OAuth `code` for an `access_token`,
holding the `client_secret` on the server side. Deploys to OCF's shared
Apache+PHP hosting in ~3 minutes.

## Prerequisites

- An OCF account (free for UC Berkeley students + alumni — https://ocf.berkeley.edu/account/)
- The client secret generated for the **anki-client (dipidoo)** OAuth App on
  github.com (Settings → Developer settings → OAuth Apps → Generate a new
  client secret). **You see it once — copy it now.**
- The OAuth App's *Authorization callback URL* set to
  `https://dipidoo.github.io/anki-client/` (exact match required).

## Deploy

Replace `USER` with your OCF username everywhere below.

### 1. SSH in

```sh
ssh USER@ssh.ocf.berkeley.edu
```

### 2. Stash the client secret outside the doc root

The script reads from `~/.config/anki-oauth/client_secret`. Doc root is
`~/public_html/`, so this path is **not** web-accessible.

```sh
mkdir -p ~/.config/anki-oauth
chmod 700 ~/.config/anki-oauth
# Paste the secret into the next command (no trailing newline):
printf '%s' 'PASTE_GITHUB_CLIENT_SECRET_HERE' > ~/.config/anki-oauth/client_secret
chmod 600 ~/.config/anki-oauth/client_secret
```

Verify:

```sh
ls -la ~/.config/anki-oauth/client_secret
# -rw-------. 1 USER ocf 40 May 23 10:00 client_secret
```

### 3. Copy `index.php` to public_html

From your laptop (in this directory):

```sh
scp index.php USER@ssh.ocf.berkeley.edu:public_html/anki-oauth/index.php
```

Or on OCF directly:

```sh
mkdir -p ~/public_html/anki-oauth
# paste index.php contents into ~/public_html/anki-oauth/index.php with nano/vim
```

### 4. Smoke test

```sh
curl -i https://www.ocf.berkeley.edu/~USER/anki-oauth/ -X OPTIONS \
  -H 'Origin: https://dipidoo.github.io' \
  -H 'Access-Control-Request-Method: POST'
```

Expect `204 No Content` plus an `Access-Control-Allow-Origin: https://dipidoo.github.io` header.

Then with a fake code (will fail at GitHub, but should round-trip through the proxy with CORS intact):

```sh
curl -i https://www.ocf.berkeley.edu/~USER/anki-oauth/ \
  -X POST -H 'Content-Type: application/json' \
  -H 'Origin: https://dipidoo.github.io' \
  -d '{"code":"obviously_fake_code"}'
```

Expect JSON like `{"error":"bad_verification_code", ...}` with the
`Access-Control-Allow-Origin` header on the response. Status will be 200 (yes,
GitHub returns 200 with an error body — that's their convention).

### 5. Plug the URL into anki-client

Edit `anki-client/public/config.json` to set:

```jsonc
"proxyUrl": "https://www.ocf.berkeley.edu/~USER/anki-oauth/"
```

Commit + push. Pages redeploys, the SPA picks up the new URL.

## Rotating the secret

1. Generate a new client secret on github.com.
2. Update `~/.config/anki-oauth/client_secret` on OCF.
3. Delete the old secret on github.com.

No client redeploy needed — the secret never appears in browser code.

## Security notes

- The script accepts only `POST` and `OPTIONS`. Other methods get 405.
- CORS allow-list is hardcoded to `https://dipidoo.github.io` (production) and
  `http://localhost:5173` (vite dev). Add other origins by editing
  `ALLOWED_ORIGINS` if you fork.
- The script does NOT cache, log, or persist the auth code or token — it forwards
  GitHub's response verbatim.
- Error log writes go to OCF's per-user PHP error log (typically
  `~/error_log` or visible via the OCF dashboard) — do not log the secret or
  the token itself.

## Why PHP and not Node / Python / Worker?

OCF is shared Apache+mod_php. PHP needs zero deploy tooling — `scp` a file,
it's live. Python (mod_wsgi) and Node (with reverse-proxy) work too but require
more setup. Cloudflare Workers would also work but adds an external dependency.

The whole script is 80 lines and portable: the same logic in any other runtime
is a 30-minute port if you ever leave OCF.
