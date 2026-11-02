#!/bin/bash
# Rebuilds WA5 and installs it into /Applications, closing any running copy.
set -e
cd "$(dirname "$0")"
VER=$(node -e "console.log(require('./package.json').version)")
echo "→ closing WA5"
pkill -f "/Applications/WA5.app" 2>/dev/null || true
sleep 2
echo "→ packaging $VER"
rm -rf dist
npx @electron/packager . WA5 --platform=darwin --arch=arm64 --overwrite \
  --out=dist --app-bundle-id=io.github.wa5 --app-version="$VER" \
  --icon=assets/icon.icns --ignore="^/(dist|docs|\.github|mcp)" 2>&1 | tail -1
echo "→ installing"
rm -rf /Applications/WA5.app
cp -R dist/WA5-darwin-arm64/WA5.app /Applications/
xattr -dr com.apple.quarantine /Applications/WA5.app 2>/dev/null || true
echo "→ opening"
open -a /Applications/WA5.app
echo "✓ WA5 $VER installed and running"
