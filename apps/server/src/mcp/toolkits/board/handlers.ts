import { OrchestratorMcpFailure, type BoardError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as BoardService from "../../../board/BoardService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BoardToolkit } from "./tools.ts";

const toFailure = (error: BoardError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const callerThreadId = (operation: string) =>
  McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, operation)),
    Effect.map(({ thread }) => thread.threadId),
  );

const handlers = {
  board_post: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("board_post");
      const board = yield* BoardService.BoardService;
      const item = yield* board
        .post({
          threadId,
          kind: input.kind,
          priority: input.priority ?? "normal",
          title: input.title,
          body: input.body ?? "",
          author: "agent",
        })
        .pipe(Effect.mapError(toFailure));
      return {
        id: item.id,
        message: "Pinned to the user's board. Don't repeat it in your reply unless it matters now.",
      };
    }),
  ),
  board_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("board_list");
      const board = yield* BoardService.BoardService;
      const items = yield* board
        .listForThread(threadId, { includeResolved: input.includeResolved === true })
        .pipe(Effect.mapError(toFailure));
      const now = DateTime.formatIso(yield* DateTime.now);
      return {
        items: items.map((item) => ({
          id: item.id,
          kind: item.kind,
          priority: item.priority,
          status: item.status,
          title: item.title,
          createdAt: item.createdAt,
          snoozed: item.snoozedUntil !== null && item.snoozedUntil > now,
        })),
      };
    }),
  ),
  board_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThreadId("board_update");
      const board = yield* BoardService.BoardService;
      const item = yield* board.updateFromAgent(threadId, input).pipe(Effect.mapError(toFailure));
      return { id: item.id, status: item.status };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof BoardToolkit.tools>;

export const layer = McpToolAccess.toLayer(BoardToolkit, handlers);
