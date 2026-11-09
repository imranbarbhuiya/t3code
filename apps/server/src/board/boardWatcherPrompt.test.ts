import { assert, it } from "@effect/vitest";

import { MAX_WATCHER_SUGGESTIONS, parseWatcherReply } from "./boardWatcherPrompt.ts";

it("parses the watcher's item blocks and drops malformed ones", () => {
  assert.deepEqual(parseWatcherReply(" none "), []);
  assert.deepEqual(
    parseWatcherReply(`Here you go.
ITEM
kind: Heads-up
priority: HIGH
title: The cache TTL was guessed
body: The agent picked 5 minutes without data.
It did not ask.
END
ITEM
kind: reminder
title: Not a real kind
END
ITEM
kind: action
title:
END
ITEM
kind: question
title: Keep the v1 endpoint?
END`),
    [
      {
        kind: "heads_up",
        priority: "high",
        title: "The cache TTL was guessed",
        body: "The agent picked 5 minutes without data.\nIt did not ask.",
      },
      { kind: "question", priority: "normal", title: "Keep the v1 endpoint?", body: "" },
    ],
  );
  const many = Array.from({ length: 5 }, (_, i) => `ITEM\nkind: note\ntitle: Note ${i}\nEND`).join(
    "\n",
  );
  assert.strictEqual(parseWatcherReply(many).length, MAX_WATCHER_SUGGESTIONS);
});
