import {
  BOARD_ITEM_BODY_MAX_LENGTH,
  BOARD_ITEM_KINDS,
  BOARD_ITEM_TITLE_MAX_LENGTH,
  type BoardItemKind,
  type BoardItemPriority,
} from "@t3tools/contracts";

export interface WatcherMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface WatcherSuggestion {
  readonly kind: BoardItemKind;
  readonly priority: BoardItemPriority;
  readonly title: string;
  readonly body: string;
}

/** Earlier conversation kept for context, and the new part the check reviews. */
const CONTEXT_CHARS = 4_000;
const NEW_CHARS = 30_000;
export const MAX_WATCHER_SUGGESTIONS = 3;

const renderMessages = (messages: ReadonlyArray<WatcherMessage>, budget: number) => {
  const rendered = messages
    .map((message) => `[${message.role}]\n${message.text.trim()}`)
    .join("\n\n");
  return rendered.length <= budget ? rendered : `…${rendered.slice(rendered.length - budget)}`;
};

export function buildWatcherPrompt(input: {
  readonly earlier: ReadonlyArray<WatcherMessage>;
  readonly recent: ReadonlyArray<WatcherMessage>;
  readonly knownTitles: ReadonlyArray<string>;
}): string {
  const known =
    input.knownTitles.length === 0
      ? "(none)"
      : input.knownTitles.map((title) => `- ${title}`).join("\n");
  return `You review a coding agent's recent work for a user who was away. Find at most ${MAX_WATCHER_SUGGESTIONS} things they should know but would miss by skimming: a tradeoff or assumption the agent made without asking, a result that may be wrong or unverified, an action only the user can take, or a question the agent left open. Skip routine progress, anything the agent's final message already states plainly, and anything already on the board.

Already on the board or seen by the user:
${known}

Earlier conversation, for context only:
${renderMessages(input.earlier, CONTEXT_CHARS) || "(none)"}

Recent work to review:
${renderMessages(input.recent, NEW_CHARS)}

Put your whole answer in the transcription field. When nothing qualifies, answer exactly NONE. Otherwise write one block per item, in this exact form:
ITEM
kind: heads_up | action | question | note
priority: normal | high
title: one line, under 120 characters, understandable without the thread
body: one to three sentences of context
END`;
}

const KINDS: ReadonlySet<string> = new Set(BOARD_ITEM_KINDS);
const isKind = (value: string | undefined): value is BoardItemKind =>
  value !== undefined && KINDS.has(value);

/** Lenient on spacing and case; drops blocks missing a valid kind or title. */
export function parseWatcherReply(reply: string): ReadonlyArray<WatcherSuggestion> {
  if (reply.trim().toUpperCase() === "NONE") return [];
  const suggestions: Array<WatcherSuggestion> = [];
  for (const block of reply.split(/^\s*ITEM\s*$/im).slice(1)) {
    const content = block.split(/^\s*END\s*$/im)[0] ?? "";
    const fields = new Map<string, string>();
    let current: string | undefined;
    for (const line of content.split("\n")) {
      const match = /^\s*(kind|priority|title|body)\s*:\s*(.*)$/i.exec(line);
      if (match) {
        current = match[1]!.toLowerCase();
        fields.set(current, match[2]!.trim());
      } else if (current === "body" && line.trim().length > 0) {
        fields.set("body", `${fields.get("body") ?? ""}\n${line.trim()}`.trim());
      }
    }
    const kind = fields
      .get("kind")
      ?.toLowerCase()
      .replace(/[\s-]+/g, "_");
    const title = fields.get("title")?.slice(0, BOARD_ITEM_TITLE_MAX_LENGTH).trim();
    if (!isKind(kind) || !title) continue;
    suggestions.push({
      kind,
      priority: fields.get("priority")?.toLowerCase() === "high" ? "high" : "normal",
      title,
      body: (fields.get("body") ?? "").slice(0, BOARD_ITEM_BODY_MAX_LENGTH),
    });
    if (suggestions.length === MAX_WATCHER_SUGGESTIONS) break;
  }
  return suggestions;
}
