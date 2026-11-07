import {
  HTML_RENDER_IMAGE_MAX_WIDTH,
  HTML_RENDER_IMAGE_MIN_WIDTH,
  type EnvironmentId,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CopyIcon, DownloadIcon } from "lucide-react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";

import { useMediaActions } from "../media/MediaActions";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Copies the whole page as a PNG the server draws at `width`; saves it where copying is blocked. */
export function HtmlRenderImageButton(props: {
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly title: string;
  readonly width: number;
  readonly variant: "glass" | "media-close";
  readonly tooltipSide: "left" | "bottom";
}) {
  const gt = useGT();
  const theme = useHtmlRenderTheme();
  const { copyImage, save } = useMediaActions({
    kind: "image",
    name: `${props.title}.png`,
    src: null,
    asset: {
      environmentId: props.environmentId,
      resource: {
        _tag: "html-render-image",
        attachmentId: props.attachmentId,
        width: Math.min(
          HTML_RENDER_IMAGE_MAX_WIDTH,
          Math.max(HTML_RENDER_IMAGE_MIN_WIDTH, Math.round(props.width)),
        ),
        theme,
      },
    },
  });
  const canCopy = Boolean(navigator.clipboard?.write) && typeof ClipboardItem !== "undefined";
  const label = canCopy ? gt("Copy as image") : gt("Save as image");

  const run = async () => {
    const toast = toastManager.add({
      type: "loading",
      title: canCopy ? gt("Copying image…") : gt("Preparing image…"),
    });
    try {
      await (canCopy ? copyImage() : save());
      toastManager.update(toast, {
        type: "success",
        title: canCopy ? gt("Image copied") : gt("Download started"),
      });
    } catch (error) {
      toastManager.update(toast, {
        type: "error",
        title: canCopy ? gt("Could not copy image") : gt("Could not save image"),
        description: error instanceof Error ? error.message : gt("Try again."),
      });
    }
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            size="icon-xs"
            variant={props.variant}
            onClick={() => void run()}
          />
        }
      >
        {canCopy ? <CopyIcon className="size-3.5" /> : <DownloadIcon className="size-3.5" />}
      </TooltipTrigger>
      <TooltipPopup side={props.tooltipSide}>{label}</TooltipPopup>
    </Tooltip>
  );
}
