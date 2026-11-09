import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BoardService from "./BoardService.ts";

const root = ThreadId.make("thread-root");
const child = ThreadId.make("thread-child");
const delegate = ThreadId.make("thread-delegate");
const other = ThreadId.make("thread-other");

// Only the lineage fields the board reads; the rest of a shell is irrelevant here.
const shell = (id: ThreadId, rootThreadId: ThreadId, delegatedFrom?: ThreadId) =>
  ({
    id,
    lineage: { rootThreadId, parentThreadId: null, relationshipToParent: null },
    ...(delegatedFrom === undefined
      ? {}
      : {
          delegatedFrom: {
            environmentId: EnvironmentId.make("env"),
            threadId: delegatedFrom,
            title: "parent",
          },
        }),
  }) as unknown as OrchestrationV2ThreadShell;

const shells = new Map([
  [root, shell(root, root)],
  [child, shell(child, root)],
  [delegate, shell(delegate, delegate, child)],
  [other, shell(other, other)],
]);

const makeBoard = BoardService.make(":memory:").pipe(
  Effect.provide(
    Layer.mergeAll(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      }),
      NodeCrypto.layer,
    ),
  ),
);

const post = (threadId: ThreadId, title: string, body = "") => ({
  threadId,
  kind: "question" as const,
  priority: "normal" as const,
  title,
  body,
  author: "agent" as const,
});

it.effect("rolls items from subagents and delegates up to the thread the user drives", () =>
  Effect.gen(function* () {
    const board = yield* makeBoard;
    const item = yield* board.post(post(delegate, "Keep the old API?"));
    assert.strictEqual(item.threadId, delegate);
    assert.strictEqual(item.boardThreadId, root);
    assert.deepEqual(
      (yield* board.listForThread(child, { includeResolved: false })).map(({ id }) => id),
      [item.id],
    );
    assert.deepEqual(yield* board.listForThread(other, { includeResolved: false }), []);
  }).pipe(Effect.scoped),
);

it.effect("posting an open title again from the same thread updates that item", () =>
  Effect.gen(function* () {
    const board = yield* makeBoard;
    const first = yield* board.post(post(root, "Rotate the API key", "before Friday"));
    const again = yield* board.post({
      ...post(root, "rotate the api key", "today"),
      priority: "high",
    });
    assert.strictEqual(again.id, first.id);
    assert.strictEqual(again.body, "today");
    assert.strictEqual(again.priority, "high");

    yield* board.updateItem({ id: first.id, status: "done" });
    const fresh = yield* board.post(post(root, "Rotate the API key"));
    assert.notStrictEqual(fresh.id, first.id);
  }).pipe(Effect.scoped),
);

it.effect("agents change only their own board's items, and reopening clears resolution", () =>
  Effect.gen(function* () {
    const board = yield* makeBoard;
    const item = yield* board.post(post(child, "Pick a cache size"));

    const foreign = yield* Effect.exit(
      board.updateFromAgent(other, { id: item.id, status: "done" }),
    );
    assert.isTrue(Exit.isFailure(foreign));

    const done = yield* board.updateFromAgent(delegate, { id: item.id, status: "done" });
    assert.strictEqual(done.status, "done");
    assert.isNotNull(done.resolvedAt);

    const reopened = yield* board.updateItem({ id: item.id, status: "open" });
    assert.strictEqual(reopened.status, "open");
    assert.isNull(reopened.resolvedAt);
  }).pipe(Effect.scoped),
);

it.effect("subscribers receive a new snapshot after each write", () =>
  Effect.gen(function* () {
    const board = yield* makeBoard;
    const subscribed = yield* Deferred.make<void>();
    const snapshots = yield* board.subscribe().pipe(
      Stream.tap(() => Deferred.succeed(subscribed, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(subscribed);
    const item = yield* board.post(post(root, "Review the migration plan"));

    const [initial, afterWrite] = yield* Fiber.join(snapshots);
    assert.deepEqual(initial?.items, []);
    assert.deepEqual(
      afterWrite?.items.map(({ id }) => id),
      [item.id],
    );
  }).pipe(Effect.scoped),
);
