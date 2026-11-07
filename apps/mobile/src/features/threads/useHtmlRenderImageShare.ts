import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  HTML_RENDER_IMAGE_MAX_WIDTH,
  HTML_RENDER_IMAGE_MIN_WIDTH,
  type EnvironmentId,
} from "@t3tools/contracts";
import type { HtmlRenderTheme } from "@t3tools/shared/htmlRender";
import * as Option from "effect/Option";
import { useEffect, useRef, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { assetEnvironment } from "../../state/assets";
import { usePreparedConnection } from "../../state/session";
import { useAtomQueryRunner } from "../../state/use-atom-query-runner";

/** Opens the share sheet with the whole page as a PNG the server draws at the reader's width. */
export function useHtmlRenderImageShare(environmentId: EnvironmentId | null) {
  const connection = usePreparedConnection(environmentId);
  const httpBaseUrl = Option.isSome(connection) ? connection.value.httpBaseUrl : null;
  const createUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    refresh: true,
    reportFailure: false,
  });
  const requestRef = useRef<AbortController | null>(null);
  const [sharing, setSharing] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the in-flight image download when the component unmounts
  useEffect(() => () => requestRef.current?.abort(), []);

  const share = (input: {
    readonly attachmentId: string;
    readonly title: string;
    readonly width: number;
    readonly theme: HtmlRenderTheme;
  }) => {
    if (requestRef.current) return;
    const request = new AbortController();
    requestRef.current = request;
    setSharing(true);
    void (async () => {
      if (environmentId === null || httpBaseUrl === null) {
        throw new Error("Reconnect to the environment and try again.");
      }
      const result = await createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "html-render-image",
            attachmentId: input.attachmentId,
            width: Math.min(
              HTML_RENDER_IMAGE_MAX_WIDTH,
              Math.max(HTML_RENDER_IMAGE_MIN_WIDTH, Math.round(input.width)),
            ),
            theme: input.theme,
          },
        },
      });
      if (request.signal.aborted) return;
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      const url = resolveAssetUrl(httpBaseUrl, result.value.relativeUrl);
      if (url === null) throw new Error("The image could not be loaded. Reconnect and try again.");
      await downloadAndShareAttachment({
        url,
        attachment: { name: `${input.title}.png`, mimeType: "image/png" },
        signal: request.signal,
      });
    })()
      .catch((error: unknown) => {
        if (!request.signal.aborted) {
          Dialog.alert(
            "Could not share image",
            error instanceof Error ? error.message : "Try again.",
          );
        }
      })
      .finally(() => {
        if (requestRef.current === request) {
          requestRef.current = null;
          setSharing(false);
        }
      });
  };

  return { share, sharing };
}
