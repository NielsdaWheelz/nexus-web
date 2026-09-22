"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import { useDismissOnOutsideOrEscape } from "@/lib/ui/useDismissOnOutsideOrEscape";
import {
  useContainingModalLayer,
  useTopmostModalLayerToken,
} from "@/lib/ui/useModalLayer";
import styles from "./ReaderDocumentMapPopup.module.css";

export type ReaderDocumentMapPopupDismissReason =
  | "escape"
  | "outside-click"
  | "focus-departure"
  | "pointer-departure"
  | "ineligible";

/** Mount immediately after the trigger; the rail owns state and return focus. */
export default function ReaderDocumentMapPopup({
  anchor,
  mode,
  id,
  label,
  children,
  onDismiss,
}: {
  anchor: HTMLButtonElement;
  mode: "Preview" | "Chooser";
  id: string;
  label: string;
  children: ReactNode;
  onDismiss: (reason: ReaderDocumentMapPopupDismissReason) => void;
}) {
  const containingModal = useContainingModalLayer();
  const topmostModal = useTopmostModalLayerToken();
  const eligible =
    containingModal === topmostModal &&
    anchor.isConnected &&
    anchor.getClientRects().length > 0 &&
    !anchor.closest("[inert], [hidden]");
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;
  const enteredChooser = useRef(false);
  const { ref: popupRef, style } = useAnchoredPosition(anchor, {
    enabled: eligible,
    placement: "left",
    align: "center",
    gap: 0,
    flip: true,
    trackAnchorMovement: true,
  });

  // Ref attachment precedes layout effects, so the positioning hook measures
  // a shown top-layer box while its initial visibility is still hidden.
  const attachPopup = useCallback((element: HTMLDivElement | null) => {
    const previous = popupRef.current;
    if (previous !== element && previous?.isConnected && previous.matches(":popover-open")) {
      previous.hidePopover();
    }
    popupRef.current = element;
    if (element && eligible && !element.matches(":popover-open")) element.showPopover();
  }, [eligible, popupRef]);

  useLayoutEffect(() => {
    if (!eligible) dismissRef.current("ineligible");
  }, [eligible]);

  useLayoutEffect(() => {
    if (mode !== "Chooser") {
      enteredChooser.current = false;
      return;
    }
    if (!eligible || style.visibility === "hidden" || enteredChooser.current) return;
    const first = popupRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)");
    if (!first) throw new Error("A document map chooser requires a destination button.");
    enteredChooser.current = true;
    first.focus({ preventScroll: true });
  }, [eligible, mode, popupRef, style.visibility]);

  const contains = useCallback((target: EventTarget | null) =>
    target instanceof Node &&
    (anchor.contains(target) || popupRef.current?.contains(target) === true),
  [anchor, popupRef]);
  const dismissOnFocusDeparture = useCallback((next: EventTarget | null) => {
    if (contains(next)) return;
    if (mode === "Preview" && (anchor.matches(":hover") || popupRef.current?.matches(":hover"))) return;
    dismissRef.current("focus-departure");
  }, [anchor, contains, mode, popupRef]);
  const dismissOnPointerDeparture = useCallback((next: EventTarget | null) => {
    if (mode === "Chooser" || contains(next) || contains(document.activeElement)) return;
    dismissRef.current("pointer-departure");
  }, [contains, mode]);

  useEffect(() => {
    if (!eligible) return;
    const onBlur = (event: FocusEvent) => dismissOnFocusDeparture(event.relatedTarget);
    const onPointerLeave = (event: PointerEvent) => dismissOnPointerDeparture(event.relatedTarget);
    // The inspector consumes bubbled Escape before the shared document listener.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      dismissRef.current("escape");
    };
    anchor.addEventListener("blur", onBlur);
    anchor.addEventListener("pointerleave", onPointerLeave);
    anchor.addEventListener("keydown", onKeyDown);
    return () => {
      anchor.removeEventListener("blur", onBlur);
      anchor.removeEventListener("pointerleave", onPointerLeave);
      anchor.removeEventListener("keydown", onKeyDown);
    };
  }, [anchor, dismissOnFocusDeparture, dismissOnPointerDeparture, eligible]);

  useDismissOnOutsideOrEscape({
    enabled: eligible,
    refs: [anchorRef, popupRef],
    onDismiss,
  });

  return (
    <div
      ref={attachPopup}
      id={id}
      popover="manual"
      role={mode === "Preview" ? "tooltip" : "group"}
      aria-labelledby={mode === "Chooser" ? `${id}-heading` : undefined}
      className={styles.popup}
      data-mode={mode}
      style={{ ...style, ...(!eligible ? { visibility: "hidden" } : {}) }}
      onBlur={(event) => dismissOnFocusDeparture(event.relatedTarget)}
      onPointerLeave={(event) => dismissOnPointerDeparture(event.relatedTarget)}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        dismissRef.current("escape");
      }}
    >
      <div className={styles.card}>
        <div id={`${id}-heading`} className={styles.heading}>{label}</div>
        <div className={styles.body}>{children}</div>
      </div>
    </div>
  );
}
