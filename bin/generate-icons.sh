#!/usr/bin/env bash
# Regenerate every icon from the two SVG sources in src-tauri/icons/src/.
#
# Checked in rather than run at build time: the PNGs have to exist for
# `tauri::include_image!` to compile, and contributors should not need
# rsvg-convert installed just to build the app. Re-run this only when the
# artwork changes.
#
# Requires: rsvg-convert, ImageMagick (magick), and macOS iconutil for .icns.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
icons="$here/src-tauri/icons"
src="$icons/src"

command -v rsvg-convert >/dev/null || { echo "need rsvg-convert (brew install librsvg)"; exit 1; }

echo "==> menubar template (black + alpha; macOS tints it)"
rsvg-convert -w 22  -h 22  "$src/tray-template.svg" -o "$icons/trayTemplate.png"
rsvg-convert -w 44  -h 44  "$src/tray-template.svg" -o "$icons/trayTemplate@2x.png"

echo "==> app icon PNGs"
rsvg-convert -w 32   -h 32   "$src/app-icon.svg" -o "$icons/32x32.png"
rsvg-convert -w 128  -h 128  "$src/app-icon.svg" -o "$icons/128x128.png"
rsvg-convert -w 256  -h 256  "$src/app-icon.svg" -o "$icons/128x128@2x.png"
rsvg-convert -w 512  -h 512  "$src/app-icon.svg" -o "$icons/icon.png"

echo "==> Windows Store logos"
for spec in "30 Square30x30Logo" "44 Square44x44Logo" "71 Square71x71Logo" \
            "89 Square89x89Logo" "107 Square107x107Logo" "142 Square142x142Logo" \
            "150 Square150x150Logo" "284 Square284x284Logo" "310 Square310x310Logo" \
            "50 StoreLogo"; do
  set -- $spec
  rsvg-convert -w "$1" -h "$1" "$src/app-icon.svg" -o "$icons/$2.png"
done

echo "==> icon.ico"
magick "$icons/icon.png" -define icon:auto-resize=256,128,64,48,32,16 "$icons/icon.ico"

echo "==> icon.icns"
if command -v iconutil >/dev/null; then
  set="$(mktemp -d)/icon.iconset"
  mkdir -p "$set"
  for spec in "16 icon_16x16" "32 icon_16x16@2x" "32 icon_32x32" "64 icon_32x32@2x" \
              "128 icon_128x128" "256 icon_128x128@2x" "256 icon_256x256" \
              "512 icon_256x256@2x" "512 icon_512x512" "1024 icon_512x512@2x"; do
    set -- $spec
    rsvg-convert -w "$1" -h "$1" "$src/app-icon.svg" -o "$set/$2.png"
  done
  iconutil -c icns "$set" -o "$icons/icon.icns"
  rm -rf "$(dirname "$set")"
else
  echo "   (skipped: iconutil is macOS-only)"
fi

echo "done."
