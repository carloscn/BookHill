# AGENTS.md

Instructions for coding agents (Claude Code, Codex, …) working on this repository. Read this before changing anything. Human-facing docs are [README.md](README.md) (English) and [docs/](docs/) (Chinese design and mechanism notes).

## What this is

langLSRW: a static web app for practising English and Spanish (dictation, speaking, sentence libraries, a 词库 with offline dictionaries, word review), live at <https://lang.mltz.tech>.

- Repository: **carloscn/BookHill**, default branch `main`. It is a fork of Aviator-shuke/BookHill and merged the older carloscn/lang_srw (archived as "moved"; do not develop there).
- The UI text is Simplified Chinese. Code, comments, commit messages and English docs are English. The files in `docs/` are written in Chinese.
- The project owner decides what ships. **Never deploy, publish a release, merge to `main`, or touch the server unless the owner asks in this conversation.**

## Hard rules

1. **No user data on the server.** The site serves only `index.html` and `src/`. Sentence libraries, dictionaries and audio are downloaded by users from a GitHub *data release* and imported or installed in the browser. Personal data lives in the browser (IndexedDB/OPFS) and, for Google users, in *their own* Google Drive (`langLSRW/` folder, `drive.file` scope). Do not add a backend that stores user data, or bundle large data into `src/`.
2. **No build step, no framework.** Plain browser JavaScript (IIFEs that attach to `window.langLSRW*`), one `index.html`, one `src/styles.css`. Pure logic goes in small modules that also `module.exports` so Node tests can load them (see `src/library-import.js`, `src/cloud-sync.js`, `src/secret-store.js`, `src/syntax-tree.js`).
3. **Every `src/…` reference in `index.html` (and the Worker URL in `src/dictionary/dictionary-service.js`) carries `?v=`.** The deploy script replaces it with a content hash, and nginx caches `.js`/`.css` as immutable for 30 days. A reference without `?v=` is never re-fetched after a change. Bump the `?v=` date when you edit a file, so local browsers reload it too.
4. **Keep the Content-Security-Policy intact** (`<meta http-equiv="Content-Security-Policy">` in `index.html`). No inline event handlers (`onclick=`), no `javascript:` URLs, no `eval`/`new Function`, no new inline `<script>`. If you edit the inline theme boot script, update its `sha256` in the CSP; `tests/csp.test.js` prints the new value. Add an origin to the CSP only if a feature really needs it.
5. **Secrets.**
   - Never commit or print private keys, tokens, OAuth client secrets or the server's IP address (it lives only in the `DEPLOY_HOST` Actions secret).
   - The Google client ID and the Picker API key in `index.html` are public by design, and restricted in Google Cloud.
   - The user's AI API key is only ever stored encrypted (`src/secret-store.js`, `localSecrets` collection, never exported or synced). Do not add code that stores or logs it in plain text, or sends it anywhere except the configured `https://` endpoint.
6. **UI style follows nav.mltz.tech.** Use the design tokens at the top of `src/styles.css` (`--surface`, `--text`, `--muted`, `--line`, `--accent`, `--green-soft`, `--radius`, `--shadow-card`, …). Do not hardcode colours. Check new UI in light **and** dark mode, in at least one other palette (`data-palette` on `<html>`), and at phone width (375 px, with no horizontal scrolling).
7. **Both learning languages.** Features that touch content must work for English **and** Spanish (`state.learningLanguageId`, `LEARNING_LANGUAGES`, `src/languages/{en,es}/`). Data that belongs to a language is stored in that language's scope.

## Development workflow

1. **Branch from the latest `main`:** `git fetch bookhill && git switch -c <type>/<topic> bookhill/main`. The remote may be called `origin` in a fresh clone. Use one branch per topic.
2. **Run locally:** `python3 -m http.server 8849`, then open <http://localhost:8849/>.
   - Choose a local user on the login screen.
   - Dictionaries are not installed in a fresh browser. Install them from 设置 → 本地词典 with the files from the [data release](https://github.com/carloscn/BookHill/releases/tag/dictionaries-2026.10), or from your own `build/dictionaries/` output.
   - 成分分析 on localhost calls the production parser at `https://lang.mltz.tech/api/parse` (CORS allows localhost).
   - Google sign-in works only on origins registered for the OAuth client.
3. **Test before every commit:**
   ```bash
   node --test tests/*.test.js .agents/skills/*/scripts/*.test.js
   for f in $(find src -name '*.js' -not -path 'src/vendor/*'); do node --check "$f"; done
   node .agents/skills/langlsrw-traditional-grammar-analysis/scripts/build-web-prompt.js --check
   ```
   Add or extend unit tests for pure logic you change. For UI changes, exercise the feature in a real browser: click through it, check the console for errors, and test light/dark and phone width.
4. **Commit** in small logical steps. Use Conventional-Commit style subjects (`feat(scope): …`, `fix: …`, `docs: …`, `ci: …`). Chinese UI terms in subjects are fine. Commit only the files you changed, and never commit `build/`.
5. **Push the branch and open a PR into `main`.** Describe what changed and how it was tested. GitHub Actions runs the tests on every push and PR.
6. **Merge and release only when the owner asks.** A release is a GitHub Release with a tag `vMAJOR.MINOR.PATCH` (for example `v2.1.0`) targeting `main`. Publishing it runs the tests, deploys to lang.mltz.tech and verifies the live `app.js` hash. Write the release notes for users: what's new and what they need to do.
7. **Update the docs in the same PR when behaviour changes:**
   - [docs/MECHANISMS.md](docs/MECHANISMS.md): runtime behaviour, storage, sync, deploy.
   - [docs/USER_DATA.md](docs/USER_DATA.md): personal-data collections.
   - [README.md](README.md): user-visible features.
   - [deploy/README.md](deploy/README.md): server and deploy.
   - [data/dictionaries/README.md](data/dictionaries/README.md): dictionary packages.

### Release types

| Tag | Purpose | Deploys? |
|---|---|---|
| `v*` (e.g. `v2.1.0`) | App release | Yes: `.github/workflows/deploy.yml` runs `deploy/deploy.sh` |
| anything else (e.g. `dictionaries-2026.10`) | Data files for users to download: dictionary packages, sentence-library TSVs, licences | No (guarded in the workflow) |

When dictionary packages change, publish a new data release and update `DICTIONARY_RELEASE_URL`, `DICTIONARY_DOWNLOAD_BASE` and the package metadata in `src/dictionary/dictionary-service.js`.

## Architecture map

| Area | Where | Notes |
|---|---|---|
| App, UI, practice flows | `src/app.js` (large; search by function name) | `state` object, `$()` = `getElementById`, `render()` / `renderTarget()` |
| Personal data | `src/user-data.js` (`window.langLSRWUserData`) | Records `{identity, scope, collection, key, value, updatedAt, deleted}` in IndexedDB. **New personal data = a new entry in `COLLECTIONS`** (`scope: "global"` or `"language"`); it is then exported, imported and synced automatically. Identities: `guest`, `local:<name>`, `cloud:<Google sub>`. |
| Settings | `persistSetting()` / `applyIdentitySettings()` in `app.js` | Synced per identity; theme is `{ mode, palette }` |
| Sentence libraries | `src/library-store.js` (IndexedDB) + `src/library-import.js` (parsing, de-dup, Sheets rows) | Synced as `langLSRW/libraries/*.tsv` |
| 我的词表 (word lists) | `wordList` collection; 词库 category `wordlist:<id>` | The Worker filters entries via `json_each`; `sort: "imported"` keeps the import order |
| Google sign-in, Drive, Picker, Sheets | `src/google-drive.js` | Token model: after a reload the user clicks 「立即同步」 to reconnect |
| Sync rules | `src/cloud-sync.js` (pure) + `syncWithCloud()` in `app.js` | Library plan and tombstones; personal data merged record by record (newer wins) |
| Dictionaries | `src/dictionary/dictionary-service.js` + `dictionary-worker.js` (sqlite-wasm, OPFS SAHPool) | Installed from a user-picked `.sqlite.gz`; Spanish frequency ranks embedded in the package |
| Sentence components | `src/syntax-tree.js` + `services/parser/` (spaCy, FastAPI, Docker on vpsde, `/api/parse`) | Parser deploy is manual: `deploy/deploy-parser.sh` |
| AI grammar analysis | `analyzeCurrentGrammar()`; prompt generated into `src/generated/grammar-prompt.js` | Edit the skill in `.agents/skills/langlsrw-traditional-grammar-analysis/`, then rerun its `build-web-prompt.js` |
| AI key | `src/secret-store.js` | AES-GCM box bound to identity + API origin |
| Styles | `src/styles.css` | Tokens and palettes first; the "nav.mltz.tech look" overrides near the end |
| Deploy | `deploy/` (`deploy.sh`, nginx config, README), `.github/workflows/deploy.yml` | Server: vpsde (Hetzner) behind Cloudflare |
| Dictionary build tools | `tools/build-*.py`, `tools/embed-spanish-frequency.py` | Write to the git-ignored `build/` |

## Server and operations

- Production is a Hetzner VPS (`vpsde`) behind Cloudflare. nginx serves `/home/carlos/langlsrw/public`, and the parser container runs on `127.0.0.1:18300`.
- GitHub Actions deploys with a key restricted by `rrsync` to the public directory. The owner runs anything that needs `sudo`; agents never have the sudo password.
- Ops steps such as SSH, nginx and Docker are outward-facing. Only do them when the owner asks, and back up a file before editing it on the server.

## Git hygiene

- Never use a bare `git stash`; use a temporary WIP commit, or a named stash you apply by SHA.
- Do not rewrite published history on `main`. Merge PRs with a merge commit.
- Do not commit generated dictionary packages, `build/`, `dist/` or anything over a few MB. Large data belongs in a data release.
