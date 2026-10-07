#!/usr/bin/env bash
# fork/ から公開するファイルだけを public/ に揃える。
# design.md / README.md / test_responsive.py は配らない。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="$here/../fork"
out="$here/public"

rm -rf "$out"
mkdir -p "$out/pages" "$out/assets" "$out/vendor"

for f in index.html tokens.css app.css favicon.svg favicon.ico \
         app.js api.js ui.js format.js demo.js notify.js notify-settings.js page-store.js \
         report-local.js report-excel.js; do
  cp "$src/$f" "$out/$f"
done

for f in "$src"/pages/*.js; do
  cp "$f" "$out/pages/$(basename "$f")"
done

if [[ -d "$src/assets" ]]; then
  cp -R "$src"/assets/. "$out/assets/"
fi
if [[ -d "$src/vendor" ]]; then
  cp -R "$src"/vendor/. "$out/vendor/"
fi

echo "public/ に $(find "$out" -type f | wc -l) ファイルを用意した"
find "$out" -type f -printf '  %P (%s bytes)\n' | sort
