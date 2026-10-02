# Deploying langLSRW to vpsde

Target: **vpsde** (an existing Hetzner box that already hosts a couple of other
static sites via nginx). Domain: **lang.mltz.tech** — DNS (Cloudflare, orange-cloud
proxied) is set up by the owner separately; this folder only covers the server side.

No credentials, tokens, or IPs are stored here. `vpsde` is an SSH host alias
already configured in `~/.ssh/config` on the deploying machine — ask the owner
if you don't have it.

## Layout

| Path | What |
|---|---|
| `deploy.sh` | rsyncs `index.html` and `src/` (code only — no sentence libraries or other data) to `vpsde:/home/carlos/langlsrw/public/` using an **allowlist** — everything else (`data/`, `script/`, `tools/`, `.agents/`, `.claude/worktrees/`, docs, `.git`) is never uploaded, and anything already on the server outside the allowlist is removed. |
| `nginx-lang-mltz.conf` | The nginx server block for `lang.mltz.tech`. Mirrors the pattern already used on this box for other `*.mltz.tech` subdomains (shared Cloudflare Origin Certificate, no new cert needed). |

Real paths on vpsde (not in this repo, live only on the box):
- `/home/carlos/langlsrw/public/` — served directory (nginx `root`)
- `/etc/nginx/sites-available/lang-mltz` (symlinked from `sites-enabled/`) — installed config

## First-time setup (one-time, needs sudo on vpsde)

1. Create the remote directory (content-only, no sudo needed — `/home/carlos` is `carlos`-owned):
   ```bash
   ssh -C -o KexAlgorithms=curve25519-sha256 vpsde 'mkdir -p /home/carlos/langlsrw/public'
   ```
2. Ship the site once:
   ```bash
   ./deploy.sh
   ```
3. Install the nginx config (needs the vpsde sudo password — not stored anywhere in this
   repo; run this yourself or hand it to whoever has it):
   ```bash
   scp -C -o KexAlgorithms=curve25519-sha256 deploy/nginx-lang-mltz.conf \
     vpsde:/home/carlos/langlsrw/lang-mltz.conf
   ssh -C -o KexAlgorithms=curve25519-sha256 vpsde \
     'sudo cp /home/carlos/langlsrw/lang-mltz.conf /etc/nginx/sites-available/lang-mltz \
      && sudo ln -sf /etc/nginx/sites-available/lang-mltz /etc/nginx/sites-enabled/lang-mltz \
      && sudo nginx -t && sudo systemctl reload nginx'
   ```
4. Point `lang.mltz.tech` at this box in Cloudflare, then verify:
   ```bash
   curl -s https://lang.mltz.tech/ | grep -o '<title>[^<]*</title>'
   ```

## Automatic deployment (GitHub Actions)

[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs the unit tests,
syntax checks and the grammar-prompt check on every push to `main` and every pull
request. It **deploys only when a GitHub Release is published**: the release's tag is
checked out, tested, synced to vpsde with `deploy/deploy.sh`, and then checked live
(`https://lang.mltz.tech/` must reference that build's `src/app.js?v=<hash>`).

To ship:

```bash
gh release create v1.2.0 --generate-notes      # or GitHub → Releases → Draft a new release
```

Emergency/manual deploy: Actions → *Test and deploy* → *Run workflow* on `main` or a
tag. Deployments never overlap (one `production` concurrency group). Runs are listed
under the repository's **Actions** tab.

How the runner reaches vpsde:

- A dedicated key (`github-actions-deploy@BookHill`) is in `~/.ssh/authorized_keys` on
  vpsde as `restrict,command="/usr/bin/rrsync /home/carlos/langlsrw/public" ssh-ed25519 …`.
  It can only rsync inside the site directory: no shell, no commands, no forwarding,
  no `..`.
- Repository secrets: `DEPLOY_SSH_KEY` (that private key), `DEPLOY_KNOWN_HOSTS` (vpsde's
  pinned ed25519 host key), `DEPLOY_HOST` (`user@origin-ip`). The origin address is a
  secret because the site sits behind Cloudflare; don't write it into the public repo.
- To rotate: generate a new key, replace the `github-actions-deploy@BookHill` line on
  vpsde, update `DEPLOY_SSH_KEY`. To disable: delete that line.

Nginx config changes are **not** automated — they still need sudo (step 3 above).

## Syntax parser service

`services/parser` (FastAPI + spaCy, Docker) serves `POST /api/parse` for 「成分分析」.
It runs on vpsde as the `langlsrw-parser` container from `/home/carlos/langlsrw/parser`,
listening on `127.0.0.1:18300` only; nginx proxies `/api/parse` to it with per-visitor rate
limiting (see `nginx-lang-mltz.conf`). It stores nothing.

- Deploy / update: `deploy/deploy-parser.sh` (rsync + `docker compose up -d --build` over the
  normal `vpsde` SSH alias, then a health check). Not part of GitHub Actions on purpose.
- Logs: `ssh vpsde 'docker logs langlsrw-parser'`. Health: `https://lang.mltz.tech/api/parse/health`.
- Limits: 500 characters per text, 4 KB request body, 3 req/s per visitor (burst 20),
  700 MB container memory (uses ~160 MB).

## Redeploying content by hand

Normally not needed (publish a Release instead). Otherwise: step 2 above — run `deploy/deploy.sh` again (`--dry-run` to preview). No sudo,
no nginx changes needed for ordinary content updates.

**No manual cache-busting.** nginx serves js/css/tsv as `immutable` for 30 days, so
every URL must change when its content does. `deploy.sh` handles this on a staged copy
(the working tree is untouched): each `?v=...` in `index.html` becomes a hash of that
file. `index.html` is served `no-cache`, so a deploy is visible on the next page load. The `?v=` values in the repo's `index.html` only
matter for the local dev server.

`LANGLSRW_DEPLOY_TARGET=/some/local/dir/ deploy/deploy.sh` stages into a local
directory instead of vpsde — handy for checking the output.

## Gotchas (carried over from this box's other static-site deploys)

1. **This site is a real multi-file app, not a single HTML fragment** — `deploy.sh`
   rsyncs the whole `src/` tree, unlike the single-file `scp` used for other
   sites on this box. Keep using `deploy.sh` rather than ad-hoc `scp` so excludes and
   `--delete` stay consistent (otherwise stale files can accumulate on the server).
2. **TLS cert is shared — don't provision a new one.** `/etc/ssl/cloudflare/origin.crt`
   already covers every `*.mltz.tech` subdomain (valid to 2041). `curl` straight to the
   box's IP needs `-k`/`--resolve` since it's a Cloudflare *origin* cert, not publicly
   trusted; only traffic through Cloudflare's edge sees a trusted chain.
3. **A missing/broken `sites-enabled/lang-mltz` symlink won't block the request** —
   `sites-enabled/00-block-all.conf` is `default_server` for port 80 only, not 443. If
   this site's TLS block isn't loaded, requests silently fall through to whichever
   `listen 443` block nginx picked instead (in practice the first site alphabetically).
   Symptom: the domain loads but shows a different site's content. Check
   `ls -la /etc/nginx/sites-enabled/` on vpsde if that happens.
4. **SSH to vpsde can silently hang on anything but tiny output.** Always add
   `-C -o KexAlgorithms=curve25519-sha256` (both are already baked into `deploy.sh`);
   use them on any ad-hoc `ssh`/`scp` to vpsde too. If a command hangs, kill it and
   retry with these flags rather than waiting it out.
5. **No sudo password for vpsde is stored anywhere in this repo.** Step 3 above needs
   it — hand the commands to the owner or whoever holds it, don't try to guess around it.

## Google sign-in (one-time setup, done by the owner)

Google sign-in is pure front-end: Google Identity Services issues a short-lived access
token in the browser, and each user's data lives in **their own** Google Drive, in a
visible `langLSRW/` folder (`langlsrw-data.json` for history/settings/AI cache/progress,
`libraries/*.tsv` for sentence libraries). You cannot see other users' data, and nothing
is stored on vpsde. Until a client ID is configured the button is shown disabled and
local (guest) users work as before.

1. <https://console.cloud.google.com/> → create a project (e.g. `langLSRW`).
2. APIs & Services → Library → enable **Google Drive API**.
3. Google Auth Platform → configure the consent screen: user type **External**, app name
   `langLSRW`, support email. Under *Data access* add the scopes `openid`, `email`,
   `profile` and `https://www.googleapis.com/auth/drive.file` (only files this app
   creates — it cannot see anything else in the user's Drive).
4. *Audience*: leave the app in **Testing** and add every Google account that should be
   able to sign in as a test user (max 100). Opening it to anyone means publishing the
   app, which may require Google's verification.
5. *Clients* → Create client → **Web application**. Authorized JavaScript origins:
   `https://lang.mltz.tech` and `http://localhost:8848`. No redirect URIs needed.
6. Paste the client ID (`….apps.googleusercontent.com`) into
   `<meta name="google-client-id" content="">` in `index.html`, commit, deploy.
   The client ID is public by design; there is no client secret in this flow.

Notes: access tokens last ~1 hour and Google only issues a new one from a click (it opens
a popup), so after that the user menu shows 「未连接」 and 「立即同步」 reconnects. Users
can revoke access at <https://myaccount.google.com/permissions>.

### Import from Google Sheets (Picker) — extra one-time setup

"从 Google 表格导入" opens Google's own file Picker; choosing a spreadsheet there grants
this app (`drive.file`) read access to that one file, and the Sheets API reads it. No
broader scope is needed. In the same Cloud project:

1. APIs & Services → Library → enable **Google Picker API** and **Google Sheets API**.
2. APIs & Services → Credentials → Create credentials → **API key**. Edit it:
   - Application restrictions → **Websites**: `https://lang.mltz.tech/*` and
     `http://localhost:8848/*`
   - API restrictions → restrict key → **Google Picker API**
3. Paste the key into `<meta name="google-api-key" content="">` in `index.html`,
   commit, deploy. Like the client ID it is public by design; the referrer
   restriction is what protects it.

The Picker's App ID is the project number, taken automatically from the client ID
prefix. A library imported from a sheet remembers it (also synced to Drive as the
`lsrwSheet` appProperty), so 「从表格更新」 re-reads it later and merges changes.
