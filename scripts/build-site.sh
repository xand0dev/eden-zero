#!/usr/bin/env bash
# Assemble the GitHub Pages site: the landing page at the root, the game at /play/.
#
#   scripts/build-site.sh [outDir]     (default: _site)
#
# The game build uses `base: './'`, so it works from any sub-path.
set -euo pipefail
out="${1:-_site}"
root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root"

# Vite is configured not to empty dist/ (see vite.config.ts), so start clean.
if [ -d dist ]; then mv dist "dist.old.$$"; fi
./node_modules/.bin/vite build --outDir dist
rm -rf "$out"
mkdir -p "$out/media/loops" "$out/media/screenshots" "$out/play"
cp site/index.html "$out/index.html"
cp -R dist/. "$out/play/"
cp docs/media/loops/*.mp4 "$out/media/loops/"
cp docs/media/demo.mp4 docs/media/game-report-uk.mp4 "$out/media/"
cp docs/screenshots/*.jpg "$out/media/screenshots/"
touch "$out/.nojekyll"
echo "site assembled in $out ($(du -sh "$out" | cut -f1))"
