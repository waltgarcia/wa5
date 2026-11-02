#!/bin/bash
# Reconstruye WA5 y la instala en /Applications. Cierra la que esté abierta.
set -e
cd "$(dirname "$0")"
VER=$(node -e "console.log(require('./package.json').version)")
echo "→ cerrando WA5"
pkill -f "/Applications/WA5.app" 2>/dev/null || true
sleep 2
echo "→ empaquetando $VER"
rm -rf dist
npx @electron/packager . WA5 --platform=darwin --arch=arm64 --overwrite \
  --out=dist --app-bundle-id=io.github.wa5 --app-version="$VER" \
  --icon=assets/icon.icns --ignore="^/(dist|docs|\.github|mcp)" 2>&1 | tail -1
echo "→ instalando"
rm -rf /Applications/WA5.app
cp -R dist/WA5-darwin-arm64/WA5.app /Applications/
xattr -dr com.apple.quarantine /Applications/WA5.app 2>/dev/null || true
echo "→ abriendo"
open -a /Applications/WA5.app
echo "✓ WA5 $VER instalada y abierta"
