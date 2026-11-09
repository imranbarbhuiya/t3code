import {
  BOARD_ITEM_BODY_MAX_LENGTH,
  BOARD_ITEM_TITLE_MAX_LENGTH,
  BoardError,
  BoardItemId,
  ThreadId,
  type BoardItem,
  type BoardItemAuthor,
  type BoardItemKind,
  type BoardItemPriority,
  type BoardItemStatus,
  type BoardSnapshot,
  type BoardUpdateItemInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

export interface BoardPostInput {
  readonly threadId: ThreadId;
  readonly kind: BoardItemKind;
  readonly priority: BoardItemPriority;
  readonly title: string;
  readonly body: string;
  readonly author: BoardItemAuthor;
}

export interface BoardAgentUpdateInput {
  readonly id: BoardItemId;
  readonly status?: BoardItemStatus | undefined;
  readonly title?: string | undefined;
  readonly body?: string | undefined;
  readonly priority?: BoardItemPriority | undefined;
}

export interface BoardWatch {
  readonly threadId: ThreadId;
  readonly checkedMessageCount: number;
}

export class BoardService extends Context.Service<
  BoardService,
  {
    /** Posting the same title from the same thread while it is open updates that item. */
    readonly post: (input: BoardPostInput) => Effect.Effect<BoardItem, BoardError>;
    /** Items on the board of the tree `threadId` belongs to, newest first. */
    readonly listForThread: (
      threadId: ThreadId,
      options: { readonly includeResolved: boolean },
    ) => Effect.Effect<ReadonlyArray<BoardItem>, BoardError>;
    /** Agents may only change items on their own tree's board. */
    readonly updateFromAgent: (
      threadId: ThreadId,
      input: BoardAgentUpdateInput,
    ) => Effect.Effect<BoardItem, BoardError>;
    readonly updateItem: (input: BoardUpdateItemInput) => Effect.Effect<BoardItem, BoardError>;
    readonly deleteItem: (id: BoardItemId) => Effect.Effect<void, BoardError>;
    readonly setWatch: (threadId: ThreadId, watched: boolean) => Effect.Effect<void, BoardError>;
    readonly listWatches: Effect.Effect<ReadonlyArray<BoardWatch>, BoardError>;
    readonly markWatchChecked: (
      threadId: ThreadId,
      checkedMessageCount: number,
    ) => Effect.Effect<void, BoardError>;
    readonly subscribe: () => Stream.Stream<BoardSnapshot, BoardError>;
  }
>()("t3/board/BoardService") {}

interface BoardItemRow {
  readonly id: string;
  readonly kind: BoardItemKind;
  readonly priority: BoardItemPriority;
  readonly status: BoardItemStatus;
  readonly author: BoardItemAuthor;
  readonly title: string;
  readonly body: string;
  readonly thread_id: string;
  readonly board_thread_id: string;
  readonly snoozed_until: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly resolved_at: string | null;
}

/** Resolved items stay visible this long; open items never expire. */
const RESOLVED_RETENTION_DAYS = 30;
const SNAPSHOT_RESOLVED_LIMIT = 300;
const MAX_LINEAGE_HOPS = 16;

const boardError = (message: string, cause?: unknown) =>
  new BoardError({ message, ...(cause === undefined ? {} : { cause }) });

const toItem = (row: BoardItemRow): BoardItem => ({
  id: BoardItemId.make(row.id),
  kind: row.kind,
  priority: row.priority,
  status: row.status,
  author: row.author,
  title: row.title,
  body: row.body,
  threadId: ThreadId.make(row.thread_id),
  boardThreadId: ThreadId.make(row.board_thread_id),
  snoozedUntil: row.snoozed_until,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  resolvedAt: row.resolved_at,
});

const clampTitle = (title: string) => title.trim().slice(0, BOARD_ITEM_TITLE_MAX_LENGTH);
const clampBody = (body: string) => body.trim().slice(0, BOARD_ITEM_BODY_MAX_LENGTH);

export const make = Effect.fn("BoardService.make")(function* (filename: string) {
  const sqlContext = yield* Layer.build(NodeSqliteClient.layer({ filename }));
  const sql = Context.get(sqlContext, SqlClient.SqlClient);
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const random = yield* SecureRandom.SecureRandom;
  // Every write re-emits the whole snapshot; slow subscribers need only the newest signal.
  const changes = yield* PubSub.sliding<void>(1);

  const now = DateTime.now.pipe(Effect.map((value) => DateTime.formatIso(value)));
  const sqlFailure = (message: string) => (cause: unknown) => boardError(message, cause);

  yield* sql`PRAGMA journal_mode = WAL`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS board_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      priority TEXT NOT NULL,
      status TEXT NOT NULL,
      author TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      board_thread_id TEXT NOT NULL,
      snoozed_until TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS board_items_board_thread ON board_items (board_thread_id, status)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS board_watches (
      thread_id TEXT PRIMARY KEY,
      checked_message_count INTEGER NOT NULL DEFAULT 0
    )
  `;
  const cutoff = DateTime.formatIso(
    DateTime.subtract(yield* DateTime.now, { days: RESOLVED_RETENTION_DAYS }),
  );
  yield* sql`DELETE FROM board_items WHERE status != 'open' AND resolved_at < ${cutoff}`;

  const notify = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

  const findItem = (id: string) =>
    sql<BoardItemRow>`SELECT * FROM board_items WHERE id = ${id}`.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(sqlFailure("Could not read the board item.")),
    );

  const requireItem = (id: string) =>
    findItem(id).pipe(
      Effect.filterOrFail(
        (row): row is BoardItemRow => row !== undefined,
        () => boardError(`Board item ${id} does not exist.`),
      ),
    );

  /** Follows subagent lineage and same-environment delegation up to the thread the user drives. */
  const resolveBoardThreadId = Effect.fn("BoardService.resolveBoardThreadId")(function* (
    threadId: ThreadId,
  ) {
    let current = threadId;
    for (let hop = 0; hop < MAX_LINEAGE_HOPS; hop++) {
      const shell = yield* threads
        .getThreadShell(current)
        .pipe(Effect.mapError(sqlFailure("Could not read the posting thread.")));
      if (shell === null) return current;
      const parent =
        shell.delegatedFrom?.threadId ??
        (shell.lineage.rootThreadId !== current ? shell.lineage.rootThreadId : undefined);
      if (parent === undefined || parent === current) return current;
      current = parent;
    }
    return current;
  });

  const post: BoardService["Service"]["post"] = Effect.fn("BoardService.post")(function* (input) {
    const title = clampTitle(input.title);
    if (title.length === 0) return yield* boardError("A board item needs a title.");
    const body = clampBody(input.body);
    const timestamp = yield* now;
    const duplicate = yield* sql<BoardItemRow>`
      SELECT * FROM board_items
      WHERE thread_id = ${input.threadId} AND status = 'open' AND lower(title) = lower(${title})
      LIMIT 1
    `.pipe(Effect.mapError(sqlFailure("Could not check for a duplicate board item.")));
    if (duplicate[0] !== undefined) {
      yield* sql`
        UPDATE board_items
        SET kind = ${input.kind}, priority = ${input.priority}, body = ${body}, updated_at = ${timestamp}
        WHERE id = ${duplicate[0].id}
      `.pipe(Effect.mapError(sqlFailure("Could not update the board item.")));
      yield* notify;
      return toItem(yield* requireItem(duplicate[0].id));
    }
    const boardThreadId = yield* resolveBoardThreadId(input.threadId);
    const id = yield* random.uuidV7().pipe(Effect.mapError(sqlFailure("Could not create an id.")));
    yield* sql`
      INSERT INTO board_items ${sql.insert({
        id,
        kind: input.kind,
        priority: input.priority,
        status: "open",
        author: input.author,
        title,
        body,
        thread_id: input.threadId,
        board_thread_id: boardThreadId,
        snoozed_until: null,
        created_at: timestamp,
        updated_at: timestamp,
        resolved_at: null,
      })}
    `.pipe(Effect.mapError(sqlFailure("Could not save the board item.")));
    yield* notify;
    return toItem(yield* requireItem(id));
  });

  const listForThread: BoardService["Service"]["listForThread"] = Effect.fn(
    "BoardService.listForThread",
  )(
    function* (threadId, options) {
      const boardThreadId = yield* resolveBoardThreadId(threadId);
      const rows = options.includeResolved
        ? yield* sql<BoardItemRow>`
          SELECT * FROM board_items WHERE board_thread_id = ${boardThreadId}
          ORDER BY created_at DESC LIMIT 200
        `
        : yield* sql<BoardItemRow>`
          SELECT * FROM board_items WHERE board_thread_id = ${boardThreadId} AND status = 'open'
          ORDER BY created_at DESC
        `;
      return rows.map(toItem);
    },
    Effect.catchTags({
      SqlError: (cause) => Effect.fail(boardError("Could not list board items.", cause)),
    }),
  );

  const writeUpdate = Effect.fn("BoardService.writeUpdate")(function* (
    row: BoardItemRow,
    changes: {
      readonly status?: BoardItemStatus | undefined;
      readonly snoozedUntil?: string | null | undefined;
      readonly title?: string | undefined;
      readonly body?: string | undefined;
      readonly priority?: BoardItemPriority | undefined;
    },
  ) {
    const timestamp = yield* now;
    const status = changes.status ?? row.status;
    const resolvedAt =
      status === "open" ? null : status === row.status ? row.resolved_at : timestamp;
    const title = changes.title === undefined ? row.title : clampTitle(changes.title);
    yield* sql`
      UPDATE board_items SET
        status = ${status},
        resolved_at = ${resolvedAt},
        snoozed_until = ${changes.snoozedUntil === undefined ? row.snoozed_until : changes.snoozedUntil},
        title = ${title.length === 0 ? row.title : title},
        body = ${changes.body === undefined ? row.body : clampBody(changes.body)},
        priority = ${changes.priority ?? row.priority},
        updated_at = ${timestamp}
      WHERE id = ${row.id}
    `.pipe(Effect.mapError(sqlFailure("Could not update the board item.")));
    yield* notify;
    return toItem(yield* requireItem(row.id));
  });

  const updateItem: BoardService["Service"]["updateItem"] = Effect.fn("BoardService.updateItem")(
    function* (input) {
      const row = yield* requireItem(input.id);
      return yield* writeUpdate(row, { status: input.status, snoozedUntil: input.snoozedUntil });
    },
  );

  const updateFromAgent: BoardService["Service"]["updateFromAgent"] = Effect.fn(
    "BoardService.updateFromAgent",
  )(function* (threadId, input) {
    const row = yield* requireItem(input.id);
    const boardThreadId = yield* resolveBoardThreadId(threadId);
    if (row.board_thread_id !== boardThreadId) {
      return yield* boardError(`Board item ${input.id} belongs to another thread's board.`);
    }
    return yield* writeUpdate(row, input);
  });

  const deleteItem: BoardService["Service"]["deleteItem"] = Effect.fn("BoardService.deleteItem")(
    function* (id) {
      yield* sql`DELETE FROM board_items WHERE id = ${id}`.pipe(
        Effect.mapError(sqlFailure("Could not delete the board item.")),
      );
      yield* notify;
    },
  );

  const setWatch: BoardService["Service"]["setWatch"] = Effect.fn("BoardService.setWatch")(
    function* (threadId, watched) {
      if (watched) {
        // Start from the current message count so the first check covers only new work.
        const { messages } = yield* threads
          .getThreadRecords(threadId, ["messages"], { messageRoles: ["user", "assistant"] })
          .pipe(Effect.mapError(sqlFailure("Could not read the thread.")));
        yield* sql`
          INSERT INTO board_watches (thread_id, checked_message_count)
          VALUES (${threadId}, ${messages.length})
          ON CONFLICT (thread_id) DO NOTHING
        `.pipe(Effect.mapError(sqlFailure("Could not turn on heads-up checks.")));
      } else {
        yield* sql`DELETE FROM board_watches WHERE thread_id = ${threadId}`.pipe(
          Effect.mapError(sqlFailure("Could not turn off heads-up checks.")),
        );
      }
      yield* notify;
    },
  );

  const listWatches: BoardService["Service"]["listWatches"] = sql<{
    readonly thread_id: string;
    readonly checked_message_count: number;
  }>`SELECT thread_id, checked_message_count FROM board_watches`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        threadId: ThreadId.make(row.thread_id),
        checkedMessageCount: row.checked_message_count,
      })),
    ),
    Effect.mapError(sqlFailure("Could not list heads-up checks.")),
  );

  const markWatchChecked: BoardService["Service"]["markWatchChecked"] = (threadId, count) =>
    sql`UPDATE board_watches SET checked_message_count = ${count} WHERE thread_id = ${threadId}`.pipe(
      Effect.asVoid,
      Effect.mapError(sqlFailure("Could not record the heads-up check.")),
    );

  const snapshot = Effect.gen(function* () {
    const open = yield* sql<BoardItemRow>`
      SELECT * FROM board_items WHERE status = 'open' ORDER BY created_at DESC
    `;
    const resolved = yield* sql<BoardItemRow>`
      SELECT * FROM board_items WHERE status != 'open'
      ORDER BY resolved_at DESC LIMIT ${SNAPSHOT_RESOLVED_LIMIT}
    `;
    const watches = yield* sql<{ readonly thread_id: string }>`SELECT thread_id FROM board_watches`;
    return {
      items: [...open, ...resolved].map(toItem),
      watchedThreadIds: watches.map((row) => ThreadId.make(row.thread_id)),
    } satisfies BoardSnapshot;
  }).pipe(Effect.mapError(sqlFailure("Could not read the board.")));

  const subscribe: BoardService["Service"]["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading so a write between the two still re-emits.
        const subscription = yield* PubSub.subscribe(changes);
        return Stream.concat(
          Stream.fromEffect(snapshot),
          Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => snapshot)),
        );
      }),
    );

  return BoardService.of({
    post,
    listForThread,
    updateFromAgent,
    updateItem,
    deleteItem,
    setWatch,
    listWatches,
    markWatchChecked,
    subscribe,
  });
});

export const layer = Layer.effect(
  BoardService,
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    return yield* make(path.join(stateDir, "board.sqlite"));
  }),
);
