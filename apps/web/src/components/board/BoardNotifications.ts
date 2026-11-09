import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BoardItem, EnvironmentId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";

import { getClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { boardLiveAtom } from "~/state/board";
import { environmentSummaries } from "~/state/presentation";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
} from "~/threadNotifications";

import { newUrgentBoardItems } from "./board.logic";

/**
 * Keeps one board subscription per environment for the app's lifetime, and announces each new
 * high-priority action item with a desktop notification while the window is hidden.
 */
export function startBoardNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const watched = new Map<EnvironmentId, () => void>();

  const present = (environmentId: EnvironmentId, item: BoardItem) => {
    if (document.visibilityState === "visible") return;
    const mode = getClientSettings().notificationMode;
    if (hasNotificationSound(mode)) {
      void playNotificationSound("input", () =>
        hasNotificationSound(getClientSettings().notificationMode),
      );
    }
    if (
      !hasDesktopNotifications(mode) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(item.title, {
        body: "Needs you, on the board",
        tag: `board:${item.id}`,
        silent: true,
      });
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        useRightPanelStore
          .getState()
          .open(scopeThreadRef(environmentId, item.boardThreadId), "board");
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: item.boardThreadId },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const watch = (environmentId: EnvironmentId) => {
    // Null until the first snapshot, which only seeds what has been seen.
    let seen: Set<string> | null = null;
    return registry.subscribe(
      boardLiveAtom(environmentId),
      (result) => {
        const snapshot = AsyncResult.getOrElse(result, () => null);
        if (snapshot === null) return;
        if (seen !== null) {
          for (const item of newUrgentBoardItems(snapshot.items, seen)) {
            present(environmentId, item);
          }
        }
        seen = new Set(snapshot.items.map((item) => item.id));
      },
      { immediate: true },
    );
  };

  const sync = () => {
    const environmentIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    for (const [environmentId, unsubscribe] of watched) {
      if (environmentIds.has(environmentId)) continue;
      unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watch(environmentId));
    }
  };

  sync();
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    sync,
  );
  return () => {
    unsubscribeEnvironmentIds();
    for (const unsubscribe of watched.values()) unsubscribe();
    watched.clear();
  };
}
