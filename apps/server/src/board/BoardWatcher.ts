import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as BoardService from "./BoardService.ts";
import {
  buildWatcherPrompt,
  parseWatcherReply,
  type WatcherMessage,
} from "./boardWatcherPrompt.ts";

const SWEEP_INTERVAL = Duration.minutes(2);
/** One check per thread per window keeps a chatty thread from spending a model call per turn. */
const COOLDOWN_MS = 10 * 60_000;
/** New text below this waits for more instead of spending a check. */
const MIN_NEW_CHARS = 800;
const KNOWN_TITLES_LIMIT = 40;

const watcherMessages = (
  messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
    readonly streaming: boolean;
    readonly createdAt: DateTime.Utc;
  }>,
): ReadonlyArray<WatcherMessage> =>
  messages
    .filter((message) => message.role !== "system" && !message.streaming)
    .toSorted((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt))
    .map((message) => ({
      role: message.role === "user" ? "user" : "assistant",
      text: message.text,
    }));

/**
 * Background heads-up check for threads the user opted in: after a turn settles, a text
 * generation model rereads the new conversation and pins what the user might miss.
 */
export const make = Effect.gen(function* () {
  const board = yield* BoardService.BoardService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const lastCheckedAt = yield* Ref.make<ReadonlyMap<ThreadId, number>>(new Map());

  const checkThread = Effect.fn("BoardWatcher.checkThread")(function* (
    watch: BoardService.BoardWatch,
  ) {
    const shell = yield* threads.getThreadShell(watch.threadId);
    // Only settled turns: a running thread's newest message is still changing.
    if (shell === null || shell.activeRunId !== null) return;
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    if (now - ((yield* Ref.get(lastCheckedAt)).get(watch.threadId) ?? 0) < COOLDOWN_MS) return;

    const { messages } = yield* threads.getThreadRecords(watch.threadId, ["messages"], {
      messageRoles: ["user", "assistant"],
    });
    const ordered = watcherMessages(messages);
    if (ordered.length <= watch.checkedMessageCount) return;
    const recent = ordered.slice(watch.checkedMessageCount);
    if (recent.reduce((total, message) => total + message.text.length, 0) < MIN_NEW_CHARS) return;

    yield* Ref.update(lastCheckedAt, (map) => new Map(map).set(watch.threadId, now));
    const known = yield* board.listForThread(watch.threadId, { includeResolved: true });
    const settings = yield* settingsService.getSettings;
    // Providers run in a working directory; the check must not read a checkout.
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-board-watch-" });
    // The transcription operation is the one free-form prompt every provider implements.
    const reply = yield* textGeneration.generateTranscriptionPostProcessing({
      cwd,
      modelSelection: settings.textGenerationModelSelection,
      prompt: buildWatcherPrompt({
        earlier: ordered.slice(0, watch.checkedMessageCount),
        recent,
        knownTitles: known.slice(0, KNOWN_TITLES_LIMIT).map((item) => item.title),
      }),
    });
    for (const suggestion of parseWatcherReply(reply.transcription)) {
      yield* board.post({ ...suggestion, threadId: watch.threadId, author: "watcher" });
    }
    yield* board.markWatchChecked(watch.threadId, ordered.length);
  }, Effect.scoped);

  const sweep = board.listWatches.pipe(
    Effect.flatMap((watches) =>
      Effect.forEach(
        watches,
        (watch) =>
          checkThread(watch).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Board heads-up check failed", {
                threadId: watch.threadId,
                cause,
              }),
            ),
          ),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) => Effect.logWarning("Board heads-up sweep failed", { cause })),
  );

  return { sweep };
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { sweep } = yield* make;
    yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL))));
  }),
);
