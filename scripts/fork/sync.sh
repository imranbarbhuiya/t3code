#!/usr/bin/env bash
# Rebases the fork's patch stack (branch `fork`) onto pingdotgg/t3code main,
# mirrors upstream main to origin/main, and pushes `fork`. Run from a checkout
# of `fork`.
#   sync.sh             exit 0: pushed or already current. exit 2: the rebase
#                       stopped on a conflict and is left in progress.
#   sync.sh --continue  after resolving and finishing that rebase, push it.
# Any other exit is an error with nothing pushed.
set -euo pipefail

mode="${1:-sync}"
if [[ "$mode" != "sync" && "$mode" != "--continue" ]]; then
  echo "usage: sync.sh [--continue]" >&2
  exit 1
fi

cd "$(git rev-parse --show-toplevel)"

if [[ "$(git branch --show-current)" != "fork" ]]; then
  echo "sync: check out the fork branch first (or finish the rebase)" >&2
  exit 1
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "sync: working tree has uncommitted changes" >&2
  exit 1
fi

git remote get-url upstream >/dev/null 2>&1 ||
  git remote add upstream https://github.com/pingdotgg/t3code.git
git config rerere.enabled true
git config rerere.autoupdate true

git fetch --quiet upstream main
git fetch --quiet origin
remote_fork="$(git rev-parse --verify --quiet origin/fork || true)"

if [[ "$mode" == "sync" ]]; then
  # Fork commits pushed from another checkout land here first.
  if [[ -n "$remote_fork" ]]; then
    git merge --ff-only --quiet origin/fork
  fi
  if ! git merge-base --is-ancestor upstream/main HEAD; then
    if ! git rebase --quiet upstream/main; then
      # rerere stages conflicts it has resolved before, but the rebase still stops.
      while [[ -d "$(git rev-parse --git-path rebase-merge)" && -z "$(git diff --name-only --diff-filter=U)" ]]; do
        GIT_EDITOR=true git rebase --continue >/dev/null || true
      done
      if [[ -d "$(git rev-parse --git-path rebase-merge)" ]]; then
        echo "sync: conflict while rebasing onto upstream $(git rev-parse --short upstream/main)" >&2
        git diff --name-only --diff-filter=U >&2
        exit 2
      fi
    fi
  fi
elif ! git merge-base --is-ancestor upstream/main HEAD; then
  echo "sync: HEAD does not contain upstream main; run sync.sh first" >&2
  exit 1
fi

git push --quiet origin upstream/main:refs/heads/main

if [[ "$(git rev-parse HEAD)" == "$remote_fork" ]]; then
  echo "sync: already current on upstream $(git rev-parse --short upstream/main)"
  exit 0
fi

git push --quiet --force-with-lease="fork:$remote_fork" origin HEAD:fork

# Upstream workflows need upstream's runners and secrets; keep new ones off.
repo="$(gh repo view "$(git remote get-url origin)" --json nameWithOwner --jq .nameWithOwner)"
gh api "repos/$repo/actions/workflows?per_page=100" \
  --jq '.workflows[] | select(.state == "active" and (.path | startswith(".github/workflows/fork-") | not)) | .id' |
  while read -r id; do gh api -X PUT "repos/$repo/actions/workflows/$id/disable" >/dev/null; done

echo "sync: pushed $(git rev-list --count upstream/main..HEAD) fork commit(s) on upstream $(git rev-parse --short upstream/main)"
