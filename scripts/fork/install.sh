#!/usr/bin/env bash
# Installs the latest fork build into /Applications. Quits a running T3 Code
# first, which stops its server and any agent turns running in it.
set -euo pipefail

repo="${T3_FORK_REPO:-imranbarbhuiya/t3code}"
work="$(mktemp -d)"
mount="$work/mount"
trap 'hdiutil detach -quiet "$mount" 2>/dev/null || true; rm -rf "$work"' EXIT

tag="$(gh release view --repo "$repo" --json tagName --jq .tagName)"
echo "install: downloading $tag"
gh release download "$tag" --repo "$repo" --pattern '*.dmg' --dir "$work"

mkdir "$mount"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$work"/*.dmg
src="$(find "$mount" -maxdepth 1 -name '*.app' -print -quit)"
if [[ -z "$src" ]]; then
  echo "install: no app found in the $tag DMG" >&2
  exit 1
fi
app="/Applications/$(basename "$src")"

# Both the official and fork builds use this bundle id.
running() { [[ "$(osascript -e 'application id "com.t3tools.t3code" is running')" == true ]]; }
if running; then osascript -e 'tell application id "com.t3tools.t3code" to quit'; fi
for _ in {1..60}; do
  running || break
  sleep 1
done
if running; then
  echo "install: T3 Code did not quit; quit it and run this again" >&2
  exit 1
fi

rm -rf "$app"
ditto "$src" "$app"
xattr -dr com.apple.quarantine "$app"
# The unsigned build carries only Electron's linker signature; sign the bundle
# ad hoc so it verifies as com.t3tools.t3code.
codesign --force --deep --sign - "$app"
codesign --verify --deep --strict "$app"
echo "install: installed $tag to $app"
open "$app"
