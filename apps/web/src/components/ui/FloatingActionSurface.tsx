"use client";

import {
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useRef,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { FeedbackRecoveryControl } from "@/components/feedback/Feedback";
import FeedbackSurface from "@/components/feedback/FeedbackSurface";
import { Scope, Session } from "@/components/feedback/scope";
import { cx } from "@/lib/ui/cx";
import { useMobileViewport } from "@/lib/mobileShell/viewport";
import { OverlayContext, focusableElements, useOverlay, useOverlayContainer, type Layer } from "@/lib/ui/overlay";
import { useAnchoredPosition, type AnchorState, type MeasuredAnchor } from "@/lib/ui/useAnchoredPosition";
import styles from "./FloatingActionSurface.module.css";

/**
 * The non-modal action surface for text selections, clicked highlights,
 * composers and action-bar popovers. Escape (and, inside a modal, Back) and a
 * press outside the surface and its anchor element dismiss it. It follows its
 * anchor through scroll, resize and the mobile bottom chrome.
 */
export default function FloatingActionSurface({
  open,
  id,
  disclosure = false,
  feedback = false,
  disclosureTrigger,
  interactionLayer,
  skipReturnFocus,
  placement,
  anchor,
  strategy = "anchor",
  selectionSession = null,
  lineRects,
  subscribeAnchor,
  align = "center",
  flip = false,
  preservePointerSelection = false,
  containsPoint,
  role,
  label,
  className,
  onDismiss,
  children,
}: {
  readonly open: boolean;
  readonly id?: string;
  /** An explicitly opened details surface, in the anchor's logical tab order. */
  readonly disclosure?: boolean;
  /** A source-owned feedback disclosure retains that source host. */
  readonly feedback?: boolean;
  /** The actual control when the positioned anchor includes its whole row. */
  readonly disclosureTrigger?: HTMLElement | null;
  readonly interactionLayer?: RefObject<Layer | null>;
  readonly skipReturnFocus?: () => boolean;
  readonly placement?: "above" | "below";
  readonly anchor: HTMLElement | DOMRect | MeasuredAnchor | null;
  /** "text-selection": above the first selected line, with a caret. */
  readonly strategy?: "anchor" | "text-selection" | "mobile-selection-actions";
  /** Current source session; retained through a compact row's temporary hiding. */
  readonly selectionSession?: string | null;
  readonly lineRects?: readonly DOMRect[];
  readonly subscribeAnchor?: (listener: () => void) => () => void;
  readonly align?: "start" | "center" | "end";
  /** Below the anchor, or above it when below does not fit. */
  readonly flip?: boolean;
  /** A press inside does not collapse the live text selection. */
  readonly preservePointerSelection?: boolean;
  /** Treat a pointer press on a logical part of the surface as inside. */
  readonly containsPoint?: (event: PointerEvent) => boolean;
  readonly role?: "group" | "toolbar" | "dialog";
  readonly label?: string;
  readonly className?: string;
  /** Back inside a modal reports "escape". */
  readonly onDismiss: (reason: "outside-click" | "escape") => void;
  /** Focusable children can wait for the first visible placement. */
  readonly children: ReactNode | ((placed: boolean, anchorState: AnchorState) => ReactNode);
}) {
  const shown = open && anchor !== null;
  const modal = useContext(OverlayContext);
  const feedbackScope = useContext(Scope);
  const session = useContext(Session);
  const [surfaceElement, setSurfaceElement] = useState<HTMLDivElement | null>(null);
  const mobileViewport = useMobileViewport();
  const trigger = disclosureTrigger ?? (typeof HTMLElement !== "undefined" && anchor instanceof HTMLElement ? anchor : null);
  const position = useAnchoredPosition<HTMLDivElement>(anchor, {
    enabled: shown,
    align,
    placement,
    keepAnchorVisible: disclosure,
    gap: 8,
    flip,
    strategy: strategy === "mobile-selection-actions" ? strategy : undefined,
    selectionSession,
    lines: strategy === "text-selection" ? (lineRects ?? []) : undefined,
    subscribeContentClearance: mobileViewport.subscribeContentBottomClearance,
    subscribeAnchor,
  });
  const bindSurface = useCallback((element: HTMLDivElement | null) => { position.ref.current = element; setSurfaceElement(element); }, [position.ref]);
  const container = useOverlayContainer();
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  const focused = useRef(false);
  const { layer } = useOverlay(shown, {
    kind: "transient",
    containsPoint,
    returnFocus: disclosure,
    skipReturnFocus,
    returnFocusTo: () => trigger ? { element: trigger, preventScroll: true } : null,
    tabContinuation: disclosure ? () => position.ref.current : undefined,
    onDismiss: (reason) =>
      dismiss.current(reason === "outside" || reason === "tab" ? "outside-click" : "escape"),
    inside: () => [
      position.ref.current,
      anchor instanceof HTMLElement ? anchor : null,
      trigger,
    ],
  });

  useLayoutEffect(() => {
    if (!shown || !feedback || !feedbackScope) return;
    feedbackScope.disclosures.add(layer);
    if (surfaceElement) feedbackScope.disclosureTargets.add(surfaceElement);
    feedbackScope.changed();
    return () => { feedbackScope.disclosures.delete(layer); if (surfaceElement) feedbackScope.disclosureTargets.delete(surfaceElement); feedbackScope.changed(); };
  }, [shown, feedback, feedbackScope, layer, surfaceElement]);
  useLayoutEffect(() => {
    if (!interactionLayer) return;
    interactionLayer.current = shown ? layer : null;
    return () => { if (interactionLayer.current === layer) interactionLayer.current = null; };
  }, [interactionLayer, layer, shown]);

  useLayoutEffect(() => {
    if (!shown) {
      focused.current = false;
      return;
    }
    const surface = position.ref.current;
    if (!disclosure || !position.placed || !surface || focused.current) return;
    focused.current = true;
    (focusableElements(surface)[0] ?? surface).focus({ preventScroll: true });
  }, [shown, disclosure, position.placed, position.ref]);

  // Children shrink to the clamped box, net of the surface's padding and border.
  const { maxWidth } = position.style;
  const maxHeight = position.style["--anchored-max-height"];
  useLayoutEffect(() => {
    const surface = position.ref.current;
    if (!surface || typeof maxWidth !== "number") return;
    if (typeof maxHeight !== "string") return;
    const computed = getComputedStyle(surface);
    const px = (value: string) => Number.parseFloat(value) || 0;
    const inline =
      px(computed.paddingLeft) +
      px(computed.paddingRight) +
      px(computed.borderLeftWidth) +
      px(computed.borderRightWidth);
    const block =
      px(computed.paddingTop) +
      px(computed.paddingBottom) +
      px(computed.borderTopWidth) +
      px(computed.borderBottomWidth);
    surface.style.setProperty(
      "--floating-action-content-max-width",
      `${Math.max(0, maxWidth - inline)}px`,
    );
    surface.style.setProperty(
      "--floating-action-content-max-height",
      `${Math.max(0, Number.parseFloat(maxHeight) - block)}px`,
    );
  }, [position.ref, maxWidth, maxHeight]);

  if (!shown || !container) return null;
  const caret =
    position.caretX === null
      ? undefined
      : { "--floating-action-caret-inline-offset": `${position.caretX}px` };
  return createPortal(
    <div
      ref={bindSurface}
      id={id}
      tabIndex={disclosure ? -1 : undefined}
      data-disclosure={disclosure || undefined}
      data-feedback-source={feedback ? feedbackScope?.host.bounds?.id || undefined : undefined}
      className={cx(styles.surface, className)}
      style={{ ...position.style, ...caret, ...(feedback && !feedbackScope?.eligible() ? { visibility: "hidden" } : {}) } as CSSProperties}
      role={role}
      aria-label={label}
      data-placement={position.side}
      data-anchor-state={position.anchorState}
      data-caret={position.caretX === null ? undefined : "true"}
      data-positioned={position.placed ? "true" : "false"}
      data-strategy={strategy}
      onPointerDown={(event) => {
        if (preservePointerSelection) event.preventDefault();
      }}
    >
      {feedback || session === null ? typeof children === "function" ? children(position.placed, position.anchorState) : children :
        <FeedbackSurface bounds={surfaceElement} interaction={layer} modal={modal} active={shown}
          protectedTargets={() => trigger ? [trigger] : []} returnFocus={() => trigger}>
          {typeof children === "function" ? children(position.placed, position.anchorState) : children}
          <FeedbackRecoveryControl />
        </FeedbackSurface>}
    </div>,
    container,
  );
}
