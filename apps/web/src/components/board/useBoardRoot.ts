import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { readThreadShell, useQuietThreadShell } from "~/state/entities";

import { resolveBoardRootThreadId } from "./board.logic";

/** The thread whose board `threadRef` shows; ancestors are read once, since lineage never moves. */
export function useBoardRootThreadId(threadRef: ScopedThreadRef | null): ThreadId | null {
  const shell = useQuietThreadShell(threadRef);
  if (threadRef === null) return null;
  return resolveBoardRootThreadId(threadRef.threadId, (threadId) =>
    threadId === threadRef.threadId
      ? shell
      : readThreadShell(scopeThreadRef(threadRef.environmentId, threadId)),
  );
}
