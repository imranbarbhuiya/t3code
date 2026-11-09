import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const BoardItemId = TrimmedNonEmptyString.pipe(Schema.brand("BoardItemId"));
export type BoardItemId = typeof BoardItemId.Type;

export const BOARD_ITEM_KINDS = ["action", "question", "heads_up", "note"] as const;
export const BoardItemKind = Schema.Literals(BOARD_ITEM_KINDS);
export type BoardItemKind = typeof BoardItemKind.Type;

export const BoardItemPriority = Schema.Literals(["normal", "high"]);
export type BoardItemPriority = typeof BoardItemPriority.Type;

export const BoardItemStatus = Schema.Literals(["open", "done", "dismissed"]);
export type BoardItemStatus = typeof BoardItemStatus.Type;

/** `watcher` items come from the background heads-up check, not the thread's own agent. */
export const BoardItemAuthor = Schema.Literals(["agent", "watcher"]);
export type BoardItemAuthor = typeof BoardItemAuthor.Type;

export const BOARD_ITEM_TITLE_MAX_LENGTH = 160;
export const BOARD_ITEM_BODY_MAX_LENGTH = 4_000;

export const BoardItem = Schema.Struct({
  id: BoardItemId,
  kind: BoardItemKind,
  priority: BoardItemPriority,
  status: BoardItemStatus,
  author: BoardItemAuthor,
  title: Schema.String,
  body: Schema.String,
  /** The thread whose agent posted the item. */
  threadId: ThreadId,
  /** The top of that thread's subagent and delegation tree; its board shows the item. */
  boardThreadId: ThreadId,
  snoozedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type BoardItem = typeof BoardItem.Type;

export const BoardSubscribeInput = Schema.Struct({});
export type BoardSubscribeInput = typeof BoardSubscribeInput.Type;

export const BoardSnapshot = Schema.Struct({
  items: Schema.Array(BoardItem),
  /** Threads with the background heads-up check turned on. */
  watchedThreadIds: Schema.Array(ThreadId),
});
export type BoardSnapshot = typeof BoardSnapshot.Type;

export const BoardUpdateItemInput = Schema.Struct({
  id: BoardItemId,
  status: Schema.optional(BoardItemStatus),
  /** Null clears a snooze. */
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type BoardUpdateItemInput = typeof BoardUpdateItemInput.Type;

export const BoardDeleteItemInput = Schema.Struct({ id: BoardItemId });
export type BoardDeleteItemInput = typeof BoardDeleteItemInput.Type;

export const BoardSetWatchInput = Schema.Struct({ threadId: ThreadId, watched: Schema.Boolean });
export type BoardSetWatchInput = typeof BoardSetWatchInput.Type;

export class BoardError extends Schema.TaggedError<BoardError>()("BoardError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
