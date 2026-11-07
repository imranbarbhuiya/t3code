import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { MinusIcon, PlusIcon, XIcon } from "lucide-react";
import { useRef, useState } from "react";

import { observeResize } from "~/lib/observeResize";

import { HtmlRenderDocument } from "../files/BrowserDocumentFrame";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { HtmlRenderImageButton } from "./HtmlRenderImageButton";

export function HtmlRenderDialog(props: {
  readonly src: string;
  readonly environmentId: EnvironmentId;
  readonly attachmentId: string;
  readonly title: string;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [pageWidth, setPageWidth] = useState(0);
  const observePage = (box: HTMLDivElement) =>
    observeResize(box, ([entry]) => {
      if (entry) setPageWidth(entry.contentRect.width);
    });
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1"
        initialFocus={closeButtonRef}
      >
        <DialogTitle className="sr-only">Expanded {props.title} preview</DialogTitle>
        <div className="relative w-[92vw]">
          <div className="absolute right-0 -top-10 z-20 flex gap-2">
            <HtmlRenderImageButton
              environmentId={props.environmentId}
              attachmentId={props.attachmentId}
              title={props.title}
              width={pageWidth}
              variant="media-close"
              tooltipSide="bottom"
            />
            <Button
              ref={closeButtonRef}
              aria-label="Close"
              size="icon-xs"
              variant="media-close"
              onClick={props.onClose}
            >
              <XIcon />
            </Button>
          </div>
          <div
            ref={observePage}
            className="h-[min(86vh,calc(100vh-160px))] overflow-auto overscroll-contain rounded-lg bg-background p-4 shadow-2xl ring-1 ring-border/70 [container-type:size]"
          >
            <div className="h-[100cqh] w-[100cqw]" style={{ zoom }}>
              <HtmlRenderDocument
                src={props.src}
                title={props.title}
                threadRef={props.threadRef}
                className="block size-full"
              />
            </div>
          </div>
          <div className="mt-2 flex min-w-0 items-center justify-center gap-3 text-xs text-white/80">
            <span className="truncate">{props.title}</span>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                aria-label="Zoom out"
                size="icon-sm"
                variant="overlay"
                disabled={zoom === 0.5}
                onClick={() => setZoom((value) => value - 0.25)}
              >
                <MinusIcon />
              </Button>
              <Button
                aria-label="Reset zoom"
                size="sm"
                variant="overlay"
                onClick={() => setZoom(1)}
              >
                {Math.round(zoom * 100)}%
              </Button>
              <Button
                aria-label="Zoom in"
                size="icon-sm"
                variant="overlay"
                disabled={zoom === 2}
                onClick={() => setZoom((value) => value + 0.25)}
              >
                <PlusIcon />
              </Button>
            </div>
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
