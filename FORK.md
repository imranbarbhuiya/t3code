# imranbarbhuiya/t3code fork

A personal build of T3 Code: upstream `pingdotgg/t3code` plus a small stack of
extra features, built for macOS (Apple silicon) only.

## Branches

- `main` mirrors upstream `main` exactly. Start feature branches here, so a
  feature can still go upstream as a clean PR.
- `fork` is the default branch: upstream `main` plus one commit per fork
  feature. It is rebased, never merged, so `git log main..fork` is the fork.

## Rules that keep syncing cheap

- No database migrations or stored-format changes. Upstream numbers migrations
  in sequence, so a fork migration would collide with a later upstream one and
  strand the database for the official app too.
- Keep wire changes additive and optional. The official mobile app and
  app.t3.codes still talk to this server.
- Prefer new files over edits to hot upstream files. Squash each feature to one
  commit (`git commit --fixup` + `git rebase --autosquash main`).
- Drop a feature's commit once upstream ships the same thing.

## Sync

`scripts/fork/sync.sh` (run from a checkout of `fork`) mirrors upstream to
`main`, rebases `fork`, and force-pushes it. It exits 2 with the rebase left in
progress on a conflict. `git rerere` is on, so a resolution is reused on later
syncs. A daily T3 Code scheduled task runs it and resolves conflicts.

Upstream workflows are disabled in this repository's Actions settings; they
target upstream's runners and secrets. Only `fork-macos.yml` runs.

Browser tests need the Chromium build pinned by the repo's Playwright. Where it
is missing, set `T3CODE_BROWSER_TEST_CHROMIUM` to another Chromium executable
and `vp run check:changed` runs them with it.

## Build and install

Every push to `fork` runs `.github/workflows/fork-macos.yml`, which publishes an
ad-hoc signed DMG as the latest release and keeps the five newest. The
`-preview.` version means no update feed, so the app never updates itself.

When GitHub has no macOS runner free, `scripts/fork/build-local.sh` builds
`origin/fork` on this Mac in a throwaway worktree and publishes the same kind
of release.

Install or update with `scripts/fork/install.sh` from Terminal. It quits
T3 Code, replaces `/Applications/T3 Code (Beta).app`, clears the quarantine
flag, and signs the bundle ad hoc.
State is shared with the official app (`~/.t3`), so switching back is just
opening the official app again; never run both at once.

T3 Connect works through the public identifiers in `.env.example`, except
desktop passkey sign-in, which needs the official signing team.

## Fork features

- **Copy or share an HTML preview as an image.** Buttons on inline `html_render`
  previews.
- **Board.** A right-panel tab (⌘⌥O) where agents pin actions, questions for
  later, heads-ups and notes with `board_post`, `board_list` and
  `board_update`. Items roll up to the top thread of a subagent or delegate
  tree and live in `board.sqlite` in the state folder, outside the shared
  migrations. "Heads-up checks" is a per-thread switch: after a turn settles,
  the text generation model rereads the new conversation and pins what you
  might miss. `apps/server/src/provider/agentContextBudget.json` holds fork
  values, so a sync that changes tool text needs it re-measured.
- **Run in background.** A running Claude command shows "Run in background"
  in its live row. The command keeps running as background work, its result
  reaches the agent when it ends, and a message waiting behind it goes in now.
