import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BoardItemKind, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  ClipboardListIcon,
  HandIcon,
  MegaphoneIcon,
  MessageCircleQuestionIcon,
  StickyNoteIcon,
} from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { boardOpenActionCountAtom, boardThreadHasOpenActionsAtom } from "~/state/board";

import { useBoardRootThreadId } from "./useBoardRoot";

export const BOARD_KIND_ICONS: Record<BoardItemKind, typeof HandIcon> = {
  action: HandIcon,
  question: MessageCircleQuestionIcon,
  heads_up: MegaphoneIcon,
  note: StickyNoteIcon,
};

export const BoardGlyph = ClipboardListIcon;

/** The Board tab's icon, with a count of open action items on the thread's board. */
export function BoardTabIcon(props: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
}) {
  const threadRef =
    props.environmentId === null || props.threadId === null
      ? null
      : scopeThreadRef(props.environmentId, props.threadId);
  const rootThreadId = useBoardRootThreadId(threadRef);
  const count = useAtomValue(
    boardOpenActionCountAtom(
      props.environmentId === null || rootThreadId === null
        ? ""
        : scopedThreadKey(scopeThreadRef(props.environmentId, rootThreadId)),
    ),
  );
  return (
    <>
      <BoardGlyph className="size-3 shrink-0" />
      {count === 0 ? null : (
        <span
          className="absolute -top-1.5 -right-1.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-warning px-0.5 font-semibold text-4xs text-white tabular-nums leading-none"
          role="status"
          aria-label={`${count} ${count === 1 ? "item needs" : "items need"} you`}
        >
          {count > 9 ? "9+" : count}
        </span>
      )}
    </>
  );
}

/** A dot on a sidebar thread row whose board has open action items. */
export function BoardThreadDot(props: { threadKey: string }) {
  const hasOpenActions = useAtomValue(boardThreadHasOpenActionsAtom(props.threadKey));
  if (!hasOpenActions) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label="Board items need you"
            className="size-1.5 shrink-0 rounded-full bg-warning"
          />
        }
      />
      <TooltipPopup side="top">Board items need you</TooltipPopup>
    </Tooltip>
  );
}
