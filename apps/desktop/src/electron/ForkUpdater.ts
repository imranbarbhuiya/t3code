/**
 * ForkUpdater - stands in for electron-updater in fork builds. macOS only installs Squirrel updates
 * signed by a Developer ID, and fork builds are signed ad hoc, so this reads the fork's GitHub
 * releases, downloads the DMG, and swaps the app bundle from a helper script after the app quits.
 *
 * @module ForkUpdater
 */
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Stands in for electron-updater, which owns its own promise-based HTTP.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStreamPromises from "node:stream/promises";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

import * as ElectronUpdater from "./ElectronUpdater.ts";

const FORK_RELEASES_REPOSITORY = "imranbarbhuiya/t3code";
export const providesUpdateFeed = true;
const FORK_TAG_PREFIX = "fork-v";
const UPSTREAM_COMMIT =
  /^Upstream: https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/commit\/([0-9a-f]{7,40})/m;
const UPSTREAM_NIGHTLY_TAG = /^v(\d+\.\d+\.\d+)-nightly\.(\d{8}\.\d+)$/;

export interface GitHubRelease {
  readonly tag_name: string;
  readonly name?: string | null;
  readonly draft: boolean;
  readonly published_at: string | null;
  readonly body?: string | null;
  readonly assets: ReadonlyArray<{ readonly name: string; readonly browser_download_url: string }>;
}

export interface ForkRelease {
  readonly version: string;
  readonly release: GitHubRelease;
  readonly dmgUrl: string;
}

export interface ReleaseNote {
  readonly version: string;
  readonly note: string;
}

const versionOf = (release: GitHubRelease) =>
  release.tag_name.startsWith(FORK_TAG_PREFIX)
    ? release.tag_name.slice(FORK_TAG_PREFIX.length)
    : undefined;

/** The newest published fork release with an arm64 DMG that is newer than `currentVersion`. */
export function newestForkRelease(
  releases: ReadonlyArray<GitHubRelease>,
  currentVersion: string,
  arch: string,
): ForkRelease | undefined {
  let newest: ForkRelease | undefined;
  for (const release of releases) {
    const version = versionOf(release);
    if (release.draft || version === undefined) continue;
    const dmg = release.assets.find((asset) => asset.name.endsWith(`-${arch}.dmg`));
    if (!dmg || compareSemverVersions(version, currentVersion) <= 0) continue;
    if (newest && compareSemverVersions(version, newest.version) <= 0) continue;
    newest = { version, release, dmgUrl: dmg.browser_download_url };
  }
  return newest;
}

export function upstreamCommitOf(
  body: string | null | undefined,
): { readonly repository: string; readonly sha: string } | undefined {
  const match = UPSTREAM_COMMIT.exec(body ?? "");
  return match?.[1] && match[2] ? { repository: match[1], sha: match[2] } : undefined;
}

/**
 * Upstream nightly notes published after the installed build's upstream commit and up to the new
 * one's, newest first. The update card keeps notes on the app's own track, so each nightly is
 * relabelled as a preview of the same build.
 */
export function upstreamNotesBetween(
  upstreamReleases: ReadonlyArray<GitHubRelease>,
  installedCommitDate: string | undefined,
  offeredCommitDate: string,
): ReadonlyArray<ReleaseNote> {
  const notes: Array<ReleaseNote & { readonly publishedAt: string }> = [];
  for (const release of upstreamReleases) {
    const match = UPSTREAM_NIGHTLY_TAG.exec(release.tag_name);
    const publishedAt = release.published_at;
    if (release.draft || !match || !publishedAt || !release.body) continue;
    if (publishedAt > offeredCommitDate) continue;
    if (installedCommitDate !== undefined && publishedAt <= installedCommitDate) continue;
    notes.push({ version: `${match[1]}-preview.${match[2]}`, note: release.body, publishedAt });
  }
  notes.sort((left, right) => right.publishedAt.localeCompare(left.publishedAt));
  const kept = installedCommitDate === undefined ? notes.slice(0, 1) : notes;
  return kept.map(({ version, note }) => ({ version, note }));
}

/** Waits for the app to exit, then replaces its bundle with the DMG's and reopens it. */
function installScript(input: {
  readonly pid: number;
  readonly dmgPath: string;
  readonly bundlePath: string;
}): string {
  const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/bash
set -euo pipefail
pid=${input.pid}
dmg=${quote(input.dmgPath)}
app=${quote(input.bundlePath)}
mount="$(mktemp -d)"
staged="$app.updating"
trap 'hdiutil detach -quiet "$mount" 2>/dev/null || true; rm -rf "$mount" "$staged"' EXIT
for _ in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
if kill -0 "$pid" 2>/dev/null; then echo "T3 Code did not quit" >&2; exit 1; fi
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$mount" "$dmg"
src="$(find "$mount" -maxdepth 1 -name '*.app' -print -quit)"
[[ -n "$src" ]] || { echo "No app in $dmg" >&2; open "$app"; exit 1; }
rm -rf "$staged"
ditto "$src" "$staged"
xattr -dr com.apple.quarantine "$staged"
codesign --force --deep --sign - "$staged"
codesign --verify --deep --strict "$staged"
rm -rf "$app"
mv "$staged" "$app"
rm -f "$dmg"
open "$app"
`;
}

const getJson = async <A>(url: string): Promise<A> => {
  const response = await fetch(url, {
    headers: { accept: "application/vnd.github+json", "user-agent": "t3code-fork-updater" },
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return (await response.json()) as A;
};

const commitDate = async (repository: string, sha: string) =>
  (
    await getJson<{ readonly commit: { readonly committer: { readonly date: string } } }>(
      `https://api.github.com/repos/${repository}/commits/${sha}`,
    )
  ).commit.committer.date;

async function releaseNotesFor(
  releases: ReadonlyArray<GitHubRelease>,
  currentVersion: string,
  offered: ForkRelease,
): Promise<ReadonlyArray<ReleaseNote>> {
  const offeredUpstream = upstreamCommitOf(offered.release.body);
  if (!offeredUpstream) return [];
  const installed = releases.find((release) => versionOf(release) === currentVersion);
  const installedUpstream = upstreamCommitOf(installed?.body);
  const [offeredDate, installedDate, upstreamReleases] = await Promise.all([
    commitDate(offeredUpstream.repository, offeredUpstream.sha),
    installedUpstream
      ? commitDate(installedUpstream.repository, installedUpstream.sha)
      : Promise.resolve(undefined),
    getJson<ReadonlyArray<GitHubRelease>>(
      `https://api.github.com/repos/${offeredUpstream.repository}/releases?per_page=30`,
    ),
  ]);
  return upstreamNotesBetween(upstreamReleases, installedDate, offeredDate);
}

const make = Effect.gen(function* () {
  const arch = yield* HostProcess.Architecture;
  const events = new NodeEvents.EventEmitter();
  // electron-updater emits "error" too; an unheard one must not throw.
  events.on("error", () => undefined);
  let offered: ForkRelease | undefined;
  let downloadedPath: string | undefined;

  const check = async () => {
    events.emit("checking-for-update");
    const currentVersion = Electron.app.getVersion();
    const releases = await getJson<ReadonlyArray<GitHubRelease>>(
      `https://api.github.com/repos/${FORK_RELEASES_REPOSITORY}/releases?per_page=10`,
    );
    offered = newestForkRelease(releases, currentVersion, arch);
    if (!offered) {
      events.emit("update-not-available", { version: currentVersion });
      return;
    }
    const notes = await releaseNotesFor(releases, currentVersion, offered).catch(() => []);
    events.emit("update-available", {
      version: offered.version,
      releaseName: offered.release.name ?? null,
      releaseNotes: notes.length > 0 ? notes : undefined,
      ...(offered.release.published_at ? { releaseDate: offered.release.published_at } : {}),
    });
  };

  const download = async () => {
    const release = offered;
    if (!release) throw new Error("No update has been found to download.");
    const response = await fetch(release.dmgUrl);
    if (!response.ok || !response.body) {
      throw new Error(`The update download failed with ${response.status}.`);
    }
    const total = Number(response.headers.get("content-length") ?? 0);
    const target = NodePath.join(NodeOS.tmpdir(), `t3code-fork-${release.version}.dmg`);
    let received = 0;
    const body = NodeStream.Readable.fromWeb(response.body as never).on("data", (chunk) => {
      received += (chunk as Buffer).length;
      if (total > 0) events.emit("download-progress", { percent: (received / total) * 100 });
    });
    await NodeStreamPromises.pipeline(body, NodeFS.createWriteStream(target));
    downloadedPath = target;
    events.emit("update-downloaded", {
      version: release.version,
      ...(release.release.published_at ? { releaseDate: release.release.published_at } : {}),
    });
  };

  const install = () => {
    if (!downloadedPath) throw new Error("The update has not been downloaded.");
    const bundlePath = NodePath.resolve(Electron.app.getPath("exe"), "../../..");
    if (!bundlePath.endsWith(".app")) throw new Error(`Cannot update ${bundlePath}.`);
    const scriptPath = NodePath.join(NodeOS.tmpdir(), "t3code-fork-install.sh");
    NodeFS.writeFileSync(
      scriptPath,
      installScript({ pid: process.pid, dmgPath: downloadedPath, bundlePath }),
      { mode: 0o700 },
    );
    const log = NodeFS.openSync(NodePath.join(NodeOS.tmpdir(), "t3code-fork-install.log"), "w");
    NodeChildProcess.spawn("/bin/bash", [scriptPath], {
      detached: true,
      stdio: ["ignore", log, log],
    }).unref();
    Electron.app.quit();
  };

  const ignore = () => Effect.void;
  return ElectronUpdater.ElectronUpdater.of({
    setFeedURL: ignore,
    setAutoDownload: ignore,
    setAutoInstallOnAppQuit: ignore,
    setChannel: ignore,
    setAllowPrerelease: ignore,
    allowDowngrade: Effect.succeed(false),
    setAllowDowngrade: ignore,
    setFullChangelog: ignore,
    setDisableDifferentialDownload: ignore,
    checkForUpdates: Effect.tryPromise({
      try: check,
      catch: (cause) => {
        events.emit("error", cause);
        return new ElectronUpdater.ElectronUpdaterCheckForUpdatesError({ channel: null, cause });
      },
    }),
    downloadUpdate: Effect.tryPromise({
      try: download,
      catch: (cause) => {
        events.emit("error", cause);
        return new ElectronUpdater.ElectronUpdaterDownloadUpdateError({ channel: null, cause });
      },
    }),
    quitAndInstall: Effect.fn("ForkUpdater.quitAndInstall")(({ isSilent, isForceRunAfter }) =>
      Effect.try({
        try: install,
        catch: (cause) =>
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel: null,
            isSilent,
            isForceRunAfter,
            cause,
          }),
      }),
    ),
    on: Effect.fn("ForkUpdater.on")((eventName, listener) => {
      const untyped = listener as unknown as (...args: Array<unknown>) => void;
      return Effect.acquireRelease(
        Effect.sync(() => events.on(eventName, untyped)),
        () => Effect.sync(() => events.removeListener(eventName, untyped)),
      ).pipe(Effect.asVoid);
    }),
  });
});

export const layer = Layer.effect(ElectronUpdater.ElectronUpdater, make);
