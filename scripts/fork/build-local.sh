#!/usr/bin/env bash
# Builds origin/fork into an Apple silicon DMG on this Mac and publishes it as
# the latest fork release, for when GitHub has no macOS runner free. Builds in a
# throwaway worktree so no checkout's files or .env are touched.
set -euo pipefail

repo="${T3_FORK_REPO:-imranbarbhuiya/t3code}"
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
work="$(dirname "$root")/t3code-fork-build"

git -C "$root" fetch --quiet origin fork
if [[ -e "$work" ]]; then
  echo "build-local: $work already exists; remove it first" >&2
  exit 1
fi
git -C "$root" worktree add --quiet --detach "$work" origin/fork
trap 'git -C "$root" worktree remove --force "$work"' EXIT
cd "$work"
sha="$(git rev-parse HEAD)"

export PATH="$root/node_modules/.bin:$PATH"
vp install --frozen-lockfile

base="$(node -p "require('./apps/desktop/package.json').version")"
version="${base}-preview.$(date -u +%Y%m%d).$(date -u +%H%M%S)"
node scripts/update-release-package-versions.ts "$version"
# Public T3 Connect identifiers, exported rather than copied into a .env.
set -a
# shellcheck disable=SC1091
source .env.example
set +a
# Without Rust, reuse the resource monitor from an installed T3 Code; it rarely changes.
if ! command -v cargo >/dev/null; then
  monitor="$(find /Applications -maxdepth 5 -path '*/T3 Code*.app/Contents/Resources/resource-monitor/t3-resource-monitor' -print -quit)"
  if [[ -z "$monitor" ]]; then
    echo "build-local: install Rust (https://rustup.rs) or a T3 Code app to reuse its resource monitor" >&2
    exit 1
  fi
  mkdir -p native/resource-monitor/target/aarch64-apple-darwin/release
  cp "$monitor" native/resource-monitor/target/aarch64-apple-darwin/release/
  export T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true
  echo "build-local: reusing resource monitor from $monitor"
fi
T3CODE_TELEMETRY_CHANNEL=dev vp run dist:desktop:dmg:arm64 --build-version "$version"

tag="fork-v${version}"
gh release create "$tag" release/*.dmg --repo "$repo" --target "$sha" \
  --title "T3 Code fork $version" --latest \
  --notes "Built locally from https://github.com/$repo/commit/$sha because no GitHub macOS runner was free."
echo "build-local: published $tag; install it with scripts/fork/install.sh"
