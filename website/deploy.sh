#!/usr/bin/env bash
# Uploads the promo page (index.html + assets/) to vpsde, served as https://bookhill.mltz.tech.
# robots.txt and sitemap.xml are generated here. nginx config: deploy/nginx-bookhill-mltz.conf.
# Usage: website/deploy.sh [--dry-run]
set -euo pipefail

cd "$(dirname "$0")"

SITE="https://bookhill.mltz.tech"
HOST="${DEPLOY_HOST:-vpsde}"
DEST="/home/carlos/bookhill-site/public/"
RSYNC_EXTRA=()
[[ "${1:-}" == "--dry-run" ]] && RSYNC_EXTRA+=(--dry-run)

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

cp index.html "$STAGE/"
cp -r assets "$STAGE/assets"
printf 'User-agent: *\nAllow: /\n\nSitemap: %s/sitemap.xml\n' "$SITE" > "$STAGE/robots.txt"
cat > "$STAGE/sitemap.xml" <<XML
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>$SITE/</loc>
    <lastmod>$(date +%F)</lastmod>
  </url>
</urlset>
XML

rsync -az --delete "${RSYNC_EXTRA[@]}" -e "ssh -C -o KexAlgorithms=curve25519-sha256 -o ConnectTimeout=10 -o BatchMode=yes" \
  "$STAGE/" "$HOST:$DEST"

echo "deployed to $HOST:$DEST"
echo "verify: curl -sI $SITE/ | head -1"
