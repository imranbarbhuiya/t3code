import {
  BOARD_ITEM_BODY_MAX_LENGTH,
  BOARD_ITEM_TITLE_MAX_LENGTH,
  BoardItemId,
  BoardItemKind,
  BoardItemPriority,
  BoardItemStatus,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as BoardService from "../../../board/BoardService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ItemId = BoardItemId.annotate({ description: "Id from board_post or board_list." });

const Title = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(BOARD_ITEM_TITLE_MAX_LENGTH),
).annotate({ description: "One line the user can act on without opening the thread." });

const Body = Schema.String.check(Schema.isMaxLength(BOARD_ITEM_BODY_MAX_LENGTH)).annotate({
  description: "Optional markdown: the context, options, or what you chose and why.",
});

const ListedItem = Schema.Struct({
  id: Schema.String,
  kind: BoardItemKind,
  priority: BoardItemPriority,
  status: BoardItemStatus,
  title: Schema.String,
  createdAt: Schema.String,
  snoozed: Schema.Boolean,
});

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  BoardService.BoardService,
];

// Board items affect only the caller's thread tree, not its workspace, so read-only sandboxes and plan mode may post.
const BoardPostTool = Tool.make("board_post", {
  description:
    "Pin something to the user's board, a list beside the chat they check after being away. Kinds: action (only the user can do it), question (for later, does not block you), heads_up (a tradeoff you chose or a result that may be off), note (something to remember). Blocking questions go to your question tool instead. Posting the same title again updates it.",
  parameters: Schema.Struct({
    kind: BoardItemKind,
    title: Title,
    body: Schema.optional(Body),
    priority: Schema.optional(
      BoardItemPriority.annotate({ description: "high only when it is urgent. Default normal." }),
    ),
  }),
  success: Schema.Struct({ id: Schema.String, message: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Post to board")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const BoardListTool = Tool.make("board_list", {
  description:
    "List items on this thread's board, including ones its subagents and delegates posted. Check before posting, and drop questions the user already answered or dismissed.",
  parameters: Schema.Struct({
    includeResolved: Schema.optional(
      Schema.Boolean.annotate({
        description: "Also list done and dismissed items. Default false.",
      }),
    ),
  }),
  success: Schema.Struct({ items: Schema.Array(ListedItem) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List board")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const BoardUpdateTool = Tool.make("board_update", {
  description:
    "Change a board item: mark it done once it no longer needs the user, or edit it when the facts change.",
  parameters: Schema.Struct({
    id: ItemId,
    status: Schema.optional(BoardItemStatus),
    title: Schema.optional(Title),
    body: Schema.optional(Body),
    priority: Schema.optional(BoardItemPriority),
  }),
  success: Schema.Struct({ id: Schema.String, status: BoardItemStatus }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update board item")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const BoardToolkit = Toolkit.make(BoardPostTool, BoardListTool, BoardUpdateTool);
