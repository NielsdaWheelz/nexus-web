"use client";

import type { ReactNode, Ref } from "react";
import Dialog from "@/components/ui/Dialog";
import MobileSheet from "@/components/ui/MobileSheet";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import styles from "@/components/media/MediaInfoOverlay.module.css";

/** Information keeps one responsive modal frame across explicit domain bodies. */
export default function InformationFrame({ open, title, returnFocusTo, returnFocusFallback, onClose, contentRef, children }: {
  readonly open: boolean;
  readonly title: string;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly returnFocusFallback: ReturnFocusTarget;
  readonly onClose: () => void;
  readonly contentRef?: Ref<HTMLDivElement>;
  readonly children: ReactNode;
}) {
  const mobile = useIsMobileViewport();
  const body = <div ref={contentRef} className={styles.body} tabIndex={-1}>{children}</div>;
  return mobile
    ? <MobileSheet active={open} onDismiss={onClose} ariaLabel={title} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>{body}</MobileSheet>
    : <Dialog open={open} onClose={onClose} title={title} returnFocusTo={returnFocusTo} returnFocusFallback={returnFocusFallback}>{body}</Dialog>;
}
