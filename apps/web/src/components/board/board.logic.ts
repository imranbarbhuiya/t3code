import type { BoardItem, BoardItemKind, EnvironmentId, ThreadId } from "@t3tools/contracts";

export type BoardFilter = "open" | "snoozed" | "done" | "dismissed";

export const BOARD_FILTERS: ReadonlyArray<{ readonly id: BoardFilter; readonly label: string }> = [
  { id: "open", label: "Open" },
  { id: "snoozed", label: "Snoozed" },
  { id: "done", label: "Done" },
  { id: "dismissed", label: "Dismissed" },
];

const BOARD_GROUPS: ReadonlyArray<{ readonly kind: BoardItemKind; readonly label: string }> = [
  { kind: "action", label: "Needs you" },
  { kind: "question", label: "Questions for later" },
  { kind: "heads_up", label: "Heads-up" },
  { kind: "note", label: "Notes" },
];

interface BoardLineageShell {
  readonly environmentId: EnvironmentId;
  readonly delegatedFrom?: { readonly threadId: ThreadId } | null | undefined;
  readonly lineage: { readonly rootThreadId: ThreadId };
}

// Matches the server's hop limit in BoardService.resolveBoardThreadId.
const MAX_LINEAGE_HOPS = 16;

/** The thread whose board shows `threadId`'s items, resolved the way the server files them. */
export function resolveBoardRootThreadId(
  threadId: ThreadId,
  lookup: (threadId: ThreadId) => BoardLineageShell | null,
): ThreadId {
  let current = threadId;
  for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop++) {
    const shell = lookup(current);
    if (shell === null) return current;
    const parent =
      shell.delegatedFrom?.threadId ??
      (shell.lineage.rootThreadId !== current ? shell.lineage.rootThreadId : undefined);
    if (parent === undefined || parent === current) return current;
    current = parent;
  }
  return current;
}

export function isBoardItemSnoozed(item: BoardItem, nowMs: number): boolean {
  return item.snoozedUntil !== null && Date.parse(item.snoozedUntil) > nowMs;
}

function boardItemFilter(item: BoardItem, nowMs: number): BoardFilter {
  if (item.status !== "open") return item.status;
  return isBoardItemSnoozed(item, nowMs) ? "snoozed" : "open";
}

/** Null scope means every item in the environment. */
export function boardItemsInScope(
  items: ReadonlyArray<BoardItem>,
  boardThreadId: ThreadId | null,
): ReadonlyArray<BoardItem> {
  return boardThreadId === null
    ? items
    : items.filter((item) => item.boardThreadId === boardThreadId);
}

export function boardFilterCounts(
  items: ReadonlyArray<BoardItem>,
  nowMs: number,
): Record<BoardFilter, number> {
  const counts: Record<BoardFilter, number> = { open: 0, snoozed: 0, done: 0, dismissed: 0 };
  for (const item of items) counts[boardItemFilter(item, nowMs)] += 1;
  return counts;
}

const byPriorityThenNewest = (left: BoardItem, right: BoardItem) =>
  (left.priority === "high" ? 0 : 1) - (right.priority === "high" ? 0 : 1) ||
  right.createdAt.localeCompare(left.createdAt);

const byRecentlyResolved = (left: BoardItem, right: BoardItem) =>
  (right.resolvedAt ?? right.updatedAt).localeCompare(left.resolvedAt ?? left.updatedAt);

const bySnoozeEnd = (left: BoardItem, right: BoardItem) =>
  (left.snoozedUntil ?? "").localeCompare(right.snoozedUntil ?? "");

export interface BoardItemGroup {
  readonly kind: BoardItemKind | null;
  readonly label: string | null;
  readonly items: ReadonlyArray<BoardItem>;
}

/** Open items come grouped by kind; the other filters are one flat list. */
export function boardItemGroups(
  items: ReadonlyArray<BoardItem>,
  filter: BoardFilter,
  nowMs: number,
): ReadonlyArray<BoardItemGroup> {
  const matching = items.filter((item) => boardItemFilter(item, nowMs) === filter);
  if (filter !== "open") {
    if (matching.length === 0) return [];
    const sorted = matching.toSorted(filter === "snoozed" ? bySnoozeEnd : byRecentlyResolved);
    return [{ kind: null, label: null, items: sorted }];
  }
  return BOARD_GROUPS.flatMap((group) => {
    const grouped = matching.filter((item) => item.kind === group.kind);
    return grouped.length === 0
      ? []
      : [{ kind: group.kind, label: group.label, items: grouped.toSorted(byPriorityThenNewest) }];
  });
}

/** When the earliest snooze ends, or null when nothing is snoozed. */
export function nextBoardSnoozeExpiryMs(
  items: ReadonlyArray<BoardItem>,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const item of items) {
    if (item.status !== "open" || item.snoozedUntil === null) continue;
    const until = Date.parse(item.snoozedUntil);
    if (until > nowMs && (next === null || until < next)) next = until;
  }
  return next;
}

export function isOpenBoardAction(item: BoardItem, nowMs: number): boolean {
  return item.kind === "action" && boardItemFilter(item, nowMs) === "open";
}

/** Board roots that have at least one open, unsnoozed action item. */
export function boardRootsWithOpenActions(
  items: ReadonlyArray<BoardItem>,
  nowMs: number,
): ReadonlySet<ThreadId> {
  const roots = new Set<ThreadId>();
  for (const item of items) {
    if (isOpenBoardAction(item, nowMs)) roots.add(item.boardThreadId);
  }
  return roots;
}

export function snoozeForOneHour(now: Date): string {
  return new Date(now.getTime() + 60 * 60_000).toISOString();
}

export function snoozeUntilTomorrowMorning(now: Date): string {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  return tomorrow.toISOString();
}

const REPLY_QUOTE_MAX_LENGTH = 600;

export function boardItemPlainText(item: Pick<BoardItem, "title" | "body">): string {
  const body = item.body.trim();
  return body.length === 0 ? item.title : `${item.title}\n\n${body}`;
}

/** A markdown quote of the item for the composer; the body is cut to keep the quote short. */
export function boardReplyQuote(item: Pick<BoardItem, "title" | "body">): string {
  const body = item.body.trim();
  const clipped =
    body.length > REPLY_QUOTE_MAX_LENGTH
      ? `${body.slice(0, REPLY_QUOTE_MAX_LENGTH).trimEnd()}…`
      : body;
  const lines = [`**${item.title.trim()}**`, ...(clipped.length === 0 ? [] : clipped.split("\n"))];
  return `${lines.map((line) => (line.length === 0 ? ">" : `> ${line}`)).join("\n")}\n\n`;
}

/** High-priority action items in `items` that `seenIds` has not seen yet. */
export function newUrgentBoardItems(
  items: ReadonlyArray<BoardItem>,
  seenIds: ReadonlySet<string>,
): ReadonlyArray<BoardItem> {
  return items.filter(
    (item) =>
      !seenIds.has(item.id) &&
      item.status === "open" &&
      item.kind === "action" &&
      item.priority === "high",
  );
}
