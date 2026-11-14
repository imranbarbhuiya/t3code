import { describe, expect, it } from "vite-plus/test";

import {
  newestForkRelease,
  upstreamCommitOf,
  upstreamNotesBetween,
  type GitHubRelease,
} from "./ForkUpdater.ts";

const SHA = "6bc105f04e8643643f274d7aa26a8571b75ac32c";

const forkRelease = (version: string, overrides: Partial<GitHubRelease> = {}): GitHubRelease => ({
  tag_name: `fork-v${version}`,
  draft: false,
  published_at: "2026-11-14T04:41:53Z",
  body: `Upstream: https://github.com/upstream-owner/t3code/commit/${SHA}\n\nFork commits:\n- feat: x (abc)`,
  assets: [
    {
      name: `T3-Code-${version}-arm64.dmg`,
      browser_download_url: `https://example.test/${version}.dmg`,
    },
  ],
  ...overrides,
});

const nightly = (tag: string, publishedAt: string): GitHubRelease => ({
  tag_name: tag,
  draft: false,
  published_at: publishedAt,
  body: `**${tag}** · 3 changes from 1 contributor\n\n- **Thing.** Did a thing.`,
  assets: [],
});

describe("newestForkRelease", () => {
  it("offers the newest fork release above the installed one for this architecture", () => {
    const releases = [
      forkRelease("0.1.9-preview.20261113.16"),
      forkRelease("0.1.9-preview.20261114.17"),
      forkRelease("0.1.9-preview.20261115.19", { draft: true }),
      forkRelease("0.1.9-preview.20261115.18", { assets: [] }),
      { ...nightly("v0.1.10-nightly.20261114.4669", "2026-11-14T03:48:27Z") },
    ];
    expect(newestForkRelease(releases, "0.1.9-preview.20261113.16", "arm64")?.version).toBe(
      "0.1.9-preview.20261114.17",
    );
    expect(newestForkRelease(releases, "0.1.9-preview.20261114.17", "arm64")).toBeUndefined();
    expect(newestForkRelease(releases, "0.1.9-preview.20261113.16", "x64")).toBeUndefined();
  });
});

describe("upstreamCommitOf", () => {
  it("reads the upstream repository and commit from a fork release body", () => {
    expect(upstreamCommitOf(forkRelease("0.1.9-preview.20261114.17").body)).toEqual({
      repository: "upstream-owner/t3code",
      sha: SHA,
    });
    expect(upstreamCommitOf("Fork commits:\n- x")).toBeUndefined();
  });
});

describe("upstreamNotesBetween", () => {
  const releases = [
    nightly("v0.1.10-nightly.20261114.4669", "2026-11-14T03:48:27Z"),
    nightly("v0.1.10-nightly.20261113.4656", "2026-11-13T21:20:49Z"),
    nightly("v0.1.10-nightly.20261113.4643", "2026-11-13T14:47:45Z"),
    nightly("v0.1.9", "2026-11-12T10:00:00Z"),
  ];

  it("keeps nightlies after the installed build's upstream commit, as previews, newest first", () => {
    expect(
      upstreamNotesBetween(releases, "2026-11-13T15:00:00Z", "2026-11-14T04:30:00Z").map(
        (note) => note.version,
      ),
    ).toEqual(["0.1.10-preview.20261114.4669", "0.1.10-preview.20261113.4656"]);
  });

  it("leaves out a nightly published after the offered build's upstream commit", () => {
    expect(
      upstreamNotesBetween(releases, "2026-11-13T15:00:00Z", "2026-11-14T00:00:00Z").map(
        (note) => note.version,
      ),
    ).toEqual(["0.1.10-preview.20261113.4656"]);
  });

  it("shows only the newest nightly when the installed build's commit is unknown", () => {
    expect(
      upstreamNotesBetween(releases, undefined, "2026-11-14T04:30:00Z").map((note) => note.version),
    ).toEqual(["0.1.10-preview.20261114.4669"]);
  });
});
