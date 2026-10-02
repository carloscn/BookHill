#!/usr/bin/env bash
# Builds and (re)starts the syntax parser (services/parser) on vpsde with
# Docker Compose. Separate from deploy.sh: the GitHub Actions deploy key can
# only rsync the static site, so parser updates are deployed by hand. They are
# rare (model or API changes); the component rules live in src/syntax-tree.js.
#
# Usage: deploy/deploy-parser.sh
set -euo pipefail

cd "$(dirname "$0")/.."

HOST="vpsde"
REMOTE_DIR="/home/carlos/langlsrw/parser"
SSH=(ssh -C -o KexAlgorithms=curve25519-sha256 -o ConnectTimeout=10 -o BatchMode=yes)

echo "Syncing services/parser to $HOST:$REMOTE_DIR ..."
rsync -rlz --delete --checksum \
  --include='/app.py' --include='/requirements.txt' --include='/Dockerfile' \
  --include='/compose.yaml' --include='/.dockerignore' --exclude='*' \
  -e "${SSH[*]}" services/parser/ "$HOST:$REMOTE_DIR/"

echo "Building and starting the container ..."
"${SSH[@]}" "$HOST" "cd '$REMOTE_DIR' && docker compose up -d --build --remove-orphans && docker image prune -f >/dev/null"

echo "Waiting for the health check ..."
for attempt in $(seq 1 30); do
  if "${SSH[@]}" "$HOST" "curl -fsS http://127.0.0.1:18300/api/parse/health" 2>/dev/null; then
    echo
    echo "parser is up."
    exit 0
  fi
  sleep 2
done
echo "parser did not become healthy; see: ssh $HOST 'docker logs langlsrw-parser'" >&2
exit 1
