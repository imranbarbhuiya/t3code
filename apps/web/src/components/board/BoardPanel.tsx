import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  type BoardItem,
  type BoardUpdateItemInput,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlarmClockIcon,
  BellOffIcon,
  CheckIcon,
  CopyIcon,
  MoreHorizontalIcon,
  ReplyIcon,
  RotateCcwIcon,
  SunriseIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { formatInlineContextReference } from "~/lib/composerContextReferences";
import { threadContextReference } from "~/lib/composerContextRecords";
import { cn } from "~/lib/utils";
import { boardClockAtom, boardLiveAtom } from "~/state/board";
import { readThreadShell, useQuietThreadShell } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import ChatMarkdown from "../ChatMarkdown";
import { RelativeTime } from "../RelativeTime";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  BOARD_FILTERS,
  type BoardFilter,
  boardFilterCounts,
  boardItemGroups,
  boardItemPlainText,
  boardItemsInScope,
  boardReplyQuote,
  isBoardItemSnoozed,
  snoozeForOneHour,
  snoozeUntilTomorrowMorning,
} from "./board.logic";
import { BOARD_KIND_ICONS, BoardGlyph } from "./BoardIcons";
import { useBoardRootThreadId } from "./useBoardRoot";

const EMPTY_STATES: Record<BoardFilter, { title: string; description: string }> = {
  open: {
    title: "Nothing needs you",
    description:
      "Agents pin decisions, questions, and heads-ups here while they work, so you can catch up later.",
  },
  snoozed: {
    title: "Nothing snoozed",
    description: "Snoozed items come back here until they wake.",
  },
  done: { title: "Nothing done yet", description: "Items you mark done stay here for a while." },
  dismissed: { title: "Nothing dismissed", description: "Dismissed items stay here for a while." },
};

const WATCH_TOOLTIP =
  "A background model rereads this thread after long turns and pins things you might miss. Uses your text generation model.";

const snoozeEndFormat = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});

function reportFailure(title: string, error: unknown) {
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

export function BoardPanel(props: {
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
}) {
  const { threadRef } = props;
  const environmentId = threadRef.environmentId;
  const query = useEnvironmentQuery(boardLiveAtom(environmentId));
  const { snapshot, nowMs } = useAtomValue(boardClockAtom(environmentId));
  const rootThreadId = useBoardRootThreadId(threadRef) ?? threadRef.threadId;
  const canOperate = useAtomValue(serverEnvironment.updateBoardItem.permissionAtom(environmentId));
  const updateItem = useAtomCommand(serverEnvironment.updateBoardItem, {
    label: "board item update",
  });
  const deleteItem = useAtomCommand(serverEnvironment.deleteBoardItem, {
    label: "board item delete",
  });
  const setWatch = useAtomCommand(serverEnvironment.setBoardWatch, { label: "board watch toggle" });
  const composerRef = useComposerHandleContext();
  const [filter, setFilter] = useState<BoardFilter>("open");
  const [allThreads, setAllThreads] = useState(false);
  const [watchPending, setWatchPending] = useState(false);

  const items = boardItemsInScope(snapshot?.items ?? [], allThreads ? null : rootThreadId);
  const counts = boardFilterCounts(items, nowMs);
  const groups = boardItemGroups(items, filter, nowMs);
  const watched = snapshot?.watchedThreadIds.includes(rootThreadId) ?? false;

  const update = async (input: BoardUpdateItemInput, failureTitle: string) => {
    const result = await updateItem({ environmentId, input });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure(failureTitle, squashAtomCommandFailure(result));
    }
  };

  const actions: BoardItemActions = {
    canOperate,
    markDone: (item) => void update({ id: item.id, status: "done" }, "Could not mark done"),
    dismiss: (item) => void update({ id: item.id, status: "dismissed" }, "Could not dismiss"),
    reopen: (item) =>
      void update({ id: item.id, status: "open", snoozedUntil: null }, "Could not reopen"),
    snooze: (item, until) => void update({ id: item.id, snoozedUntil: until }, "Could not snooze"),
    unsnooze: (item) => void update({ id: item.id, snoozedUntil: null }, "Could not unsnooze"),
    remove: async (item) => {
      const result = await deleteItem({ environmentId, input: { id: item.id } });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        reportFailure("Could not delete", squashAtomCommandFailure(result));
      }
    },
    copy: async (item) => {
      try {
        await writeTextToClipboard(boardItemPlainText(item));
      } catch (error) {
        reportFailure("Could not copy", error);
      }
    },
    reply: (item) => {
      const composer = composerRef?.current;
      if (!composer) {
        toastManager.add({
          type: "error",
          title: "Unable to reply",
          description: "Open this thread's chat and try again.",
        });
        return;
      }
      const sourceRef = scopeThreadRef(environmentId, item.threadId);
      const source = item.threadId === threadRef.threadId ? null : readThreadShell(sourceRef);
      const record = source === null ? null : threadContextRecord(sourceRef, source.title);
      const alreadyAttached =
        record !== null &&
        (
          useComposerDraftStore.getState().getComposerDraft(props.composerDraftTarget)
            ?.threadContexts ?? []
        ).some((existing) => existing.contextId === record.contextId);
      const sourceLine =
        record === null
          ? ""
          : alreadyAttached
            ? `From ${formatInlineContextReference(threadContextReference(record))} `
            : "From ";
      const inserted = composer.insertTextAtEnd(`${boardReplyQuote(item)}${sourceLine}`, {
        ensureLeadingBoundary: true,
      });
      if (!inserted) {
        toastManager.add({
          type: "error",
          title: "Unable to reply",
          description: "The chat isn't ready to accept input right now.",
        });
        return;
      }
      // Lands at the caret, right after "From ".
      if (record !== null && !alreadyAttached) {
        useComposerDraftStore.getState().addThreadContexts(props.composerDraftTarget, [record]);
      }
      composer.focusAtEnd();
    },
  };

  const toggleWatch = async (next: boolean) => {
    if (watchPending) return;
    setWatchPending(true);
    const result = await setWatch({
      environmentId,
      input: { threadId: rootThreadId, watched: next },
    });
    setWatchPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      reportFailure("Could not change heads-up checks", squashAtomCommandFailure(result));
    }
  };

  if (snapshot === null && query.error !== null) {
    return (
      <Empty size="compact">
        <EmptyMedia variant="icon">
          <BoardGlyph />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>Board unavailable</EmptyTitle>
          <EmptyDescription>{query.error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-board-panel>
      <div className="flex flex-col gap-2 border-b border-border/60 px-3 py-2">
        <ToggleGroup
          variant="segmented"
          aria-label="Board filter"
          value={[filter]}
          onValueChange={(next) => {
            const nextFilter = BOARD_FILTERS.find((entry) => entry.id === next[0])?.id;
            if (nextFilter) setFilter(nextFilter);
          }}
        >
          {BOARD_FILTERS.map((entry) => (
            <Toggle key={entry.id} value={entry.id}>
              {entry.label}
              {counts[entry.id] > 0 && (entry.id === "open" || entry.id === "snoozed") ? (
                <span className="text-muted-foreground tabular-nums">{counts[entry.id]}</span>
              ) : null}
            </Toggle>
          ))}
        </ToggleGroup>
        <div className="flex items-center justify-between gap-3 text-xs">
          <label className="flex cursor-pointer items-center gap-2">
            <Switch size="sm" checked={allThreads} onCheckedChange={setAllThreads} />
            All threads
          </label>
          <Tooltip>
            <TooltipTrigger
              render={<label className="flex cursor-pointer items-center gap-2 text-right" />}
            >
              Heads-up checks
              <Switch
                size="sm"
                checked={watched}
                disabled={!canOperate || watchPending || snapshot === null}
                onCheckedChange={(next) => void toggleWatch(next)}
              />
            </TooltipTrigger>
            <TooltipPopup side="bottom" className="max-w-64">
              {WATCH_TOOLTIP}
            </TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {groups.length === 0 ? (
        snapshot === null ? null : (
          <Empty size="compact">
            <EmptyMedia variant="icon">
              <BoardGlyph />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>{EMPTY_STATES[filter].title}</EmptyTitle>
              <EmptyDescription>{EMPTY_STATES[filter].description}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
          {groups.map((group) => (
            <section
              key={group.kind ?? "all"}
              className="mb-3 last:mb-0"
              aria-label={group.label ?? undefined}
            >
              {group.label === null ? null : (
                <h3 className="mb-1 px-1 font-medium text-muted-foreground text-xs">
                  {group.label}
                  <span className="ml-1.5 tabular-nums">{group.items.length}</span>
                </h3>
              )}
              <ul className="flex flex-col gap-1.5">
                {group.items.map((item) => (
                  <BoardItemRow
                    key={item.id}
                    item={item}
                    threadRef={threadRef}
                    showSource={allThreads || item.threadId !== threadRef.threadId}
                    snoozed={isBoardItemSnoozed(item, nowMs)}
                    actions={actions}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

interface BoardItemActions {
  readonly canOperate: boolean;
  readonly markDone: (item: BoardItem) => void;
  readonly dismiss: (item: BoardItem) => void;
  readonly reopen: (item: BoardItem) => void;
  readonly snooze: (item: BoardItem, until: string) => void;
  readonly unsnooze: (item: BoardItem) => void;
  readonly remove: (item: BoardItem) => Promise<void>;
  readonly copy: (item: BoardItem) => Promise<void>;
  readonly reply: (item: BoardItem) => void;
}

function BoardItemRow(props: {
  item: BoardItem;
  threadRef: ScopedThreadRef;
  showSource: boolean;
  snoozed: boolean;
  actions: BoardItemActions;
}) {
  const { item, actions } = props;
  const [expanded, setExpanded] = useState(false);
  const KindIcon = BOARD_KIND_ICONS[item.kind];
  const open = item.status === "open";
  const body = item.body.trim();

  return (
    <li
      className={cn(
        "group/board-item relative rounded-md border border-border/60 bg-card px-2.5 py-2",
        item.priority === "high" && open && "border-l-2 border-l-warning",
      )}
      data-board-item={item.id}
    >
      <div className="flex min-w-0 items-start gap-2">
        <KindIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <button
            type="button"
            className="block w-full cursor-pointer text-left font-semibold text-sm leading-5 outline-none focus-visible:underline"
            aria-expanded={body.length === 0 ? undefined : expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {item.priority === "high" && open ? (
              <span className="sr-only">High priority: </span>
            ) : null}
            {item.title}
          </button>
          {body.length === 0 ? null : (
            <div
              className={cn("mt-0.5 text-muted-foreground text-xs", !expanded && "line-clamp-2")}
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("a, button")) return;
                setExpanded((value) => !value);
              }}
            >
              <ChatMarkdown
                text={body}
                cwd={undefined}
                threadRef={props.threadRef}
                environmentId={props.threadRef.environmentId}
              />
            </div>
          )}
          <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
            <BoardItemMeta
              item={item}
              threadRef={props.threadRef}
              showSource={props.showSource}
              snoozed={props.snoozed}
            />
            <BoardItemActionBar item={item} snoozed={props.snoozed} actions={actions} />
          </div>
        </div>
      </div>
    </li>
  );
}

function BoardItemMeta(props: {
  item: BoardItem;
  threadRef: ScopedThreadRef;
  showSource: boolean;
  snoozed: boolean;
}) {
  const { item } = props;
  const navigate = useNavigate();
  const sourceRef = props.showSource
    ? scopeThreadRef(props.threadRef.environmentId, item.threadId)
    : null;
  const source = useQuietThreadShell(sourceRef);
  const openSource = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: props.threadRef.environmentId, threadId },
    });
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-2xs text-muted-foreground">
      {sourceRef === null ? null : (
        <>
          <button
            type="button"
            className="max-w-48 cursor-pointer truncate underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:underline"
            onClick={() => openSource(item.threadId)}
          >
            {source?.title ?? "Another thread"}
          </button>
          <span aria-hidden>·</span>
        </>
      )}
      {props.snoozed && item.snoozedUntil !== null ? (
        <span>Snoozed until {snoozeEndFormat.format(new Date(item.snoozedUntil))}</span>
      ) : (
        <RelativeTime timestamp={item.resolvedAt ?? item.createdAt} />
      )}
      {item.author === "watcher" ? (
        <>
          <span aria-hidden>·</span>
          <span>Heads-up check</span>
        </>
      ) : null}
    </div>
  );
}

function BoardItemActionBar(props: {
  item: BoardItem;
  snoozed: boolean;
  actions: BoardItemActions;
}) {
  const { item, actions } = props;
  const open = item.status === "open";
  const disabled = !actions.canOperate;
  return (
    <div
      className={cn(
        "-my-1 flex shrink-0 items-center justify-end gap-1",
        "opacity-0 group-hover/board-item:opacity-100 group-focus-within/board-item:opacity-100 has-[[data-popup-open]]:opacity-100 pointer-coarse:opacity-100",
      )}
    >
      {open ? (
        <Button size="xs" variant="ghost" onClick={() => actions.reply(item)}>
          <ReplyIcon className="size-3.5" />
          Reply
        </Button>
      ) : null}
      {open && props.snoozed ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => actions.unsnooze(item)}
        >
          <BellOffIcon className="size-3.5" />
          Unsnooze
        </Button>
      ) : null}
      {open ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled}
          onClick={() => actions.markDone(item)}
        >
          <CheckIcon className="size-3.5" />
          Done
        </Button>
      ) : (
        <Button size="xs" variant="ghost" disabled={disabled} onClick={() => actions.reopen(item)}>
          <RotateCcwIcon className="size-3.5" />
          Reopen
        </Button>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-xs" aria-label={`More actions for ${item.title}`}>
              <MoreHorizontalIcon className="size-3.5" />
            </Button>
          }
        />
        <MenuPopup align="end" side="bottom" sideOffset={4}>
          {open ? (
            <>
              <MenuItem
                disabled={disabled}
                onClick={() => actions.snooze(item, snoozeForOneHour(new Date()))}
              >
                <AlarmClockIcon className="size-3.5" />
                Snooze 1 hour
              </MenuItem>
              <MenuItem
                disabled={disabled}
                onClick={() => actions.snooze(item, snoozeUntilTomorrowMorning(new Date()))}
              >
                <SunriseIcon className="size-3.5" />
                Snooze until tomorrow 9:00
              </MenuItem>
              <MenuItem disabled={disabled} onClick={() => actions.dismiss(item)}>
                <XIcon className="size-3.5" />
                Dismiss
              </MenuItem>
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem onClick={() => void actions.copy(item)}>
            <CopyIcon className="size-3.5" />
            Copy text
          </MenuItem>
          <MenuItem disabled={disabled} onClick={() => void actions.remove(item)}>
            <Trash2Icon className="size-3.5" />
            Delete
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}
