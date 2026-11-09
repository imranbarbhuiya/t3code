import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  type ServerSettings as ServerSettingsSchema,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as BoardService from "./BoardService.ts";
import * as BoardWatcher from "./BoardWatcher.ts";

const threadId = ThreadId.make("thread-watched");
const REPLY =
  "ITEM\nkind: heads_up\ntitle: Retries were turned off\nbody: To make the test pass.\nEND";

// Only the fields the board and watcher read.
const message = (index: number, text: string) =>
  ({
    role: index % 2 === 0 ? "user" : "assistant",
    text,
    streaming: false,
    createdAt: DateTime.makeUnsafe(index * 1_000),
  }) as unknown as OrchestrationV2ConversationMessage;

it.effect("checks a settled thread once enough new work arrives, then waits out its cooldown", () =>
  Effect.gen(function* () {
    const messages = yield* Ref.make<ReadonlyArray<OrchestrationV2ConversationMessage>>([]);
    const running = yield* Ref.make(false);
    const prompts = yield* Ref.make<ReadonlyArray<string>>([]);

    const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () =>
        Ref.get(running).pipe(
          Effect.map(
            (isRunning) =>
              ({
                id: threadId,
                activeRunId: isRunning ? "run" : null,
                lineage: {
                  rootThreadId: threadId,
                  parentThreadId: null,
                  relationshipToParent: null,
                },
              }) as unknown as OrchestrationV2ThreadShell,
          ),
        ),
      getThreadRecords: (() =>
        Ref.get(messages).pipe(
          Effect.map((current) => ({ messages: current })),
        )) as ThreadManagementService.ThreadManagementService["Service"]["getThreadRecords"],
    });
    const layer = Layer.mergeAll(
      threads,
      Layer.mock(TextGeneration.TextGeneration)({
        generateTranscriptionPostProcessing: (input) =>
          Ref.update(prompts, (all) => [...all, input.prompt]).pipe(
            Effect.as({ transcription: REPLY }),
          ),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          textGenerationModelSelection: {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            model: "claude-haiku-5-5",
          },
        } as unknown as ServerSettingsSchema),
      }),
      NodeServices.layer,
      NodeCrypto.layer,
    );

    yield* Effect.gen(function* () {
      const board = yield* BoardService.make(":memory:");
      const { sweep } = yield* BoardWatcher.make.pipe(
        Effect.provideService(BoardService.BoardService, board),
      );
      yield* TestClock.adjust("1 hour");
      yield* board.setWatch(threadId, true);

      // Too little new text: wait for more.
      yield* Ref.set(messages, [message(0, "fix the flaky test")]);
      yield* sweep;
      assert.strictEqual((yield* Ref.get(prompts)).length, 0);

      // A running turn is still changing.
      yield* Ref.set(messages, [message(0, "fix the flaky test"), message(1, "x".repeat(900))]);
      yield* Ref.set(running, true);
      yield* sweep;
      assert.strictEqual((yield* Ref.get(prompts)).length, 0);

      yield* Ref.set(running, false);
      yield* sweep;
      assert.strictEqual((yield* Ref.get(prompts)).length, 1);
      const posted = yield* board.listForThread(threadId, { includeResolved: false });
      assert.deepEqual(
        posted.map(({ author, kind, title }) => ({ author, kind, title })),
        [{ author: "watcher", kind: "heads_up", title: "Retries were turned off" }],
      );

      // New work inside the cooldown waits; after it, only the new messages are reviewed.
      yield* Ref.update(messages, (all) => [
        ...all,
        message(2, "next"),
        message(3, "y".repeat(900)),
      ]);
      yield* sweep;
      assert.strictEqual((yield* Ref.get(prompts)).length, 1);
      yield* TestClock.adjust("11 minutes");
      yield* sweep;
      const lastPrompt = (yield* Ref.get(prompts))[1] ?? "";
      assert.include(lastPrompt.split("Recent work to review:")[1] ?? "", "y".repeat(900));
      assert.notInclude(lastPrompt.split("Recent work to review:")[1] ?? "", "x".repeat(900));
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.scoped),
);
