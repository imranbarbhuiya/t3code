import { deadlineStore } from "@t3tools/client-runtime/clock";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { BoardSnapshot, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import {
  boardRootsWithOpenActions,
  isOpenBoardAction,
  nextBoardSnoozeExpiryMs,
} from "../components/board/board.logic";
import { serverEnvironment } from "./server";

/** One live board per environment, shared by the panel, tab badge, sidebar and notifications. */
export const boardLiveAtom = (environmentId: EnvironmentId) =>
  serverEnvironment.boardLive({ environmentId, input: {} });

interface BoardClock {
  readonly snapshot: BoardSnapshot | null;
  readonly nowMs: number;
}

/** The snapshot and the time it was judged at; rebuilds once when the earliest snooze ends. */
export const boardClockAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): BoardClock => {
    const snapshot = AsyncResult.getOrElse(get(boardLiveAtom(environmentId)), () => null);
    const nowMs = Date.now();
    const expiry = snapshot === null ? null : nextBoardSnoozeExpiryMs(snapshot.items, nowMs);
    if (expiry !== null) get.addFinalizer(deadlineStore(expiry).subscribe(() => get.refreshSelf()));
    return { snapshot, nowMs };
  }).pipe(Atom.withLabel(`web-board-clock:${environmentId}`)),
);

const EMPTY_ROOTS: ReadonlySet<ThreadId> = new Set();

const boardRootsWithOpenActionsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const { snapshot, nowMs } = get(boardClockAtom(environmentId));
    return snapshot === null ? EMPTY_ROOTS : boardRootsWithOpenActions(snapshot.items, nowMs);
  }).pipe(Atom.withLabel(`web-board-roots-with-actions:${environmentId}`)),
);

/** Keyed by scoped thread key: whether that thread's board has open action items. */
export const boardThreadHasOpenActionsAtom = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  return Atom.make((get) =>
    ref === null ? false : get(boardRootsWithOpenActionsAtom(ref.environmentId)).has(ref.threadId),
  ).pipe(Atom.withLabel(`web-board-thread-has-actions:${threadKey}`));
});

/** Keyed by scoped thread key of a board root: its open, unsnoozed action items. */
export const boardOpenActionCountAtom = Atom.family((threadKey: string) => {
  const ref = parseScopedThreadKey(threadKey);
  return Atom.make((get) => {
    if (ref === null) return 0;
    const { snapshot, nowMs } = get(boardClockAtom(ref.environmentId));
    let count = 0;
    for (const item of snapshot?.items ?? []) {
      if (item.boardThreadId === ref.threadId && isOpenBoardAction(item, nowMs)) count += 1;
    }
    return count;
  }).pipe(Atom.withLabel(`web-board-open-actions:${threadKey}`));
});
