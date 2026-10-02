#!/usr/bin/env bash
# Syncs the static app (index.html + src/) to vpsde. The server holds code
# only: sentence libraries, dictionaries and audio are imported by each user
# (stored in their browser / Google Drive), never served from here. Uses an
# allowlist, so anything else in the checkout (assets/, data/, docs/, tools/,
# .agents/, node_modules/, .git …) can never leak onto the server.
#
# Files are staged first so cache-busting is automatic (nginx serves js/css/
# wasm as immutable for 30 days): every `src/…?v=…` reference is replaced with
# a hash of the referenced file — first inside src/ JavaScript (e.g. the
# dictionary worker URL), then in index.html. The working tree is untouched.
#
# Usage: deploy/deploy.sh [--dry-run]
# LANGLSRW_DEPLOY_TARGET overrides the destination (e.g. a local dir for testing).
# Requires a `vpsde` SSH host entry (see deploy/README.md), rsync and python3.
set -euo pipefail

cd "$(dirname "$0")/.."

REMOTE="${LANGLSRW_DEPLOY_TARGET:-vpsde:/home/carlos/langlsrw/public/}"
SSH_OPTS="ssh -C -o KexAlgorithms=curve25519-sha256 -o ConnectTimeout=10 -o BatchMode=yes"
RSYNC_EXTRA=()
[[ "${1:-}" == "--dry-run" ]] && RSYNC_EXTRA+=(--dry-run)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

rsync -a \
  --include='/index.html' \
  --include='/src/***' \
  --exclude='*' \
  ./ "$STAGE/"

python3 - "$STAGE" <<'PY'
import hashlib, pathlib, re, sys

stage = pathlib.Path(sys.argv[1])
reference = re.compile(r'((?<![\w./-])src/[^"\'?\s]+)\?v=[^"\'\s]*')

def short_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()[:10]

def stamp(file):
    text = file.read_text(encoding="utf-8")
    def replace(match):
        target = stage / match.group(1)
        if not target.is_file():
            sys.exit(f"{file.relative_to(stage)} references missing file: {match.group(1)}")
        return f"{match.group(1)}?v={short_hash(target)}"
    text, count = reference.subn(replace, text)
    if count:
        file.write_text(text, encoding="utf-8")
    return count

# Referenced-by-JS files first (their hashes feed index.html), vendor untouched.
scripts = [p for p in sorted((stage / "src").rglob("*.js")) if "vendor" not in p.parts]
inner = sum(stamp(p) for p in scripts)
outer = stamp(stage / "index.html")
print(f"stamped {inner} reference(s) inside src/ and {outer} in index.html")
PY

echo "Deploying langLSRW to $REMOTE ..."
# --checksum: staged files always have fresh mtimes, so compare by content.
rsync -rlvz --checksum --delete "${RSYNC_EXTRA[@]}" \
  -e "$SSH_OPTS" \
  "$STAGE/" "$REMOTE"

echo "done. verify:"
echo "  curl -s https://lang.mltz.tech/ | grep -o '<title>[^<]*</title>'"
