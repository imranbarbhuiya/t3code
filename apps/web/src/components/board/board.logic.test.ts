import { type BoardItem, BoardItemId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  boardFilterCounts,
  boardItemGroups,
  boardReplyQuote,
  boardRootsWithOpenActions,
  newUrgentBoardItems,
  nextBoardSnoozeExpiryMs,
  resolveBoardRootThreadId,
  snoozeUntilTomorrowMorning,
} from "./board.logic";

const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const env = EnvironmentId.make("env-1");
const root = ThreadId.make("root");

const iso = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

const item = (id: string, overrides: Partial<BoardItem> = {}): BoardItem => ({
  id: BoardItemId.make(id),
  kind: "action",
  priority: "normal",
  status: "open",
  author: "agent",
  title: id,
  body: "",
  threadId: root,
  boardThreadId: root,
  snoozedUntil: null,
  createdAt: iso(-60),
  updatedAt: iso(-60),
  resolvedAt: null,
  ...overrides,
});

const ids = (items: ReadonlyArray<BoardItem>) => items.map((entry) => entry.id);

describe("resolveBoardRootThreadId", () => {
  const shells = new Map([
    [
      "subagent",
      {
        environmentId: env,
        delegatedFrom: null,
        lineage: { rootThreadId: ThreadId.make("parent") },
      },
    ],
    [
      "parent",
      {
        environmentId: env,
        delegatedFrom: { threadId: root },
        lineage: { rootThreadId: ThreadId.make("parent") },
      },
    ],
    ["root", { environmentId: env, delegatedFrom: null, lineage: { rootThreadId: root } }],
  ]);
  const lookup = (threadId: ThreadId) => shells.get(threadId) ?? null;

  it.each([
    ["root", "root"],
    ["subagent", "root"],
    ["parent", "root"],
    ["unknown", "unknown"],
  ])("files %s under %s", (threadId, expected) => {
    expect(resolveBoardRootThreadId(ThreadId.make(threadId), lookup)).toBe(expected);
  });

  it("stops on a delegation cycle", () => {
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    const cyclic = (threadId: ThreadId) => ({
      environmentId: env,
      delegatedFrom: { threadId: threadId === a ? b : a },
      lineage: { rootThreadId: threadId },
    });
    expect([a, b]).toContain(resolveBoardRootThreadId(a, cyclic));
  });
});

describe("board filters and groups", () => {
  const items = [
    item("old-action", { createdAt: iso(-120) }),
    item("new-action", { createdAt: iso(-10) }),
    item("urgent-old-action", { priority: "high", createdAt: iso(-300) }),
    item("question", { kind: "question" }),
    item("note", { kind: "note" }),
    item("snoozed-later", { snoozedUntil: iso(120) }),
    item("snoozed-soon", { snoozedUntil: iso(30) }),
    item("snooze-ended", { snoozedUntil: iso(-5) }),
    item("done-early", { status: "done", resolvedAt: iso(-50) }),
    item("done-late", { status: "done", resolvedAt: iso(-5) }),
    item("dismissed", { status: "dismissed", resolvedAt: iso(-5) }),
  ];

  it("counts a past snooze as open and a future one as snoozed", () => {
    expect(boardFilterCounts(items, NOW)).toEqual({ open: 6, snoozed: 2, done: 2, dismissed: 1 });
  });

  it("groups open items by kind, high priority first, then newest", () => {
    expect(
      boardItemGroups(items, "open", NOW).map((group) => [group.label, ids(group.items)]),
    ).toEqual([
      ["Needs you", ["urgent-old-action", "new-action", "snooze-ended", "old-action"]],
      ["Questions for later", ["question"]],
      ["Notes", ["note"]],
    ]);
  });

  it.each([
    ["snoozed", ["snoozed-soon", "snoozed-later"]],
    ["done", ["done-late", "done-early"]],
    ["dismissed", ["dismissed"]],
  ] as const)("lists %s items flat", (filter, expected) => {
    const groups = boardItemGroups(items, filter, NOW);
    expect(groups.map((group) => ids(group.items))).toEqual([expected]);
  });

  it("finds the earliest snooze still running", () => {
    expect(nextBoardSnoozeExpiryMs(items, NOW)).toBe(NOW + 30 * 60_000);
    expect(nextBoardSnoozeExpiryMs(items, NOW + 200 * 60_000)).toBeNull();
  });

  it("marks only boards with open, unsnoozed action items", () => {
    const other = ThreadId.make("other");
    const quiet = ThreadId.make("quiet");
    const roots = boardRootsWithOpenActions(
      [
        item("a", { boardThreadId: other }),
        item("b", { boardThreadId: quiet, kind: "question" }),
        item("c", { boardThreadId: quiet, snoozedUntil: iso(10) }),
        item("d", { boardThreadId: quiet, status: "done" }),
      ],
      NOW,
    );
    expect([...roots]).toEqual([other]);
  });
});

describe("newUrgentBoardItems", () => {
  it("returns unseen, open, high-priority action items", () => {
    const items = [
      item("seen", { priority: "high" }),
      item("fresh", { priority: "high" }),
      item("normal"),
      item("question", { kind: "question", priority: "high" }),
      item("resolved", { priority: "high", status: "done" }),
    ];
    expect(ids(newUrgentBoardItems(items, new Set(["seen"])))).toEqual(["fresh"]);
  });
});

describe("boardReplyQuote", () => {
  it("quotes the title and every body line", () => {
    expect(boardReplyQuote({ title: "Pick a DB", body: "Postgres?\n\nOr SQLite?" })).toBe(
      "> **Pick a DB**\n> Postgres?\n>\n> Or SQLite?\n\n",
    );
  });

  it("clips a long body", () => {
    const quote = boardReplyQuote({ title: "T", body: "x".repeat(700) });
    expect(quote).toContain(`> ${"x".repeat(600)}…`);
    expect(quote).not.toContain("x".repeat(601));
  });
});

it("snoozes until 9:00 local time tomorrow", () => {
  const until = new Date(snoozeUntilTomorrowMorning(new Date(2026, 10, 9, 23, 30)));
  expect([until.getDate(), until.getHours(), until.getMinutes()]).toEqual([10, 9, 0]);
});
