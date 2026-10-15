"use client";

import {
  useCallback,
  useId,
  useLayoutEffect,
  useState,
  type FocusEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import type { DestinationId } from "@/lib/navigation/destinations";
import { hasActiveInteractionOwner, useOverlay, useOverlayContainer } from "@/lib/ui/overlay";
import { useAnchoredPosition } from "@/lib/ui/useAnchoredPosition";
import styles from "./AppNav.module.css";

type RailTooltipControlId = DestinationId | "Nexus.Open";

/** One passive caption for the collapsed rail; only fresh entry or focus opens it. */
export function useRailTooltip(enabled: boolean): {
  trigger(controlId: RailTooltipControlId, text: string): {
    "aria-describedby": string | undefined;
    onPointerEnter(event: PointerEvent<HTMLElement>): void;
    onPointerLeave(event: PointerEvent<HTMLElement>): void;
    onFocus(event: FocusEvent<HTMLElement>): void;
    onBlur(event: FocusEvent<HTMLElement>): void;
  };
  dismiss(): void;
  readonly tooltip: ReactNode;
} {
  const [active, setActive] = useState<{ controlId: RailTooltipControlId; anchor: HTMLElement; text: string } | null>(null);
  const id = useId();
  const container = useOverlayContainer();
  const anchor = active?.anchor ?? null;
  const open = enabled && anchor !== null && container !== null;
  const dismiss = useCallback(() => setActive(null), []);
  const position = useAnchoredPosition<HTMLDivElement>(anchor, {
    enabled: open,
    placement: "right",
    align: "center",
    gap: 0,
  });
  const { topmost } = useOverlay(open, {
    kind: "transient",
    eligible: () => false,
    onDismiss: dismiss,
    inside: () => [anchor, position.ref.current],
  });
  const mounted = open && topmost;
  const visible = mounted && position.placed;

  useLayoutEffect(() => {
    if (!enabled || !topmost) dismiss();
  }, [dismiss, enabled, topmost]);

  useLayoutEffect(() => {
    if (!mounted || !active) return;
    const { anchor } = active;
    // Placement follows scrolling; intersection also accounts for the rail's clipping.
    const intersection = new IntersectionObserver(([entry]) => {
      if (entry && (entry.intersectionRect.width === 0 || entry.intersectionRect.height === 0)) {
        setActive((current) => current === active ? null : current);
      }
    });
    intersection.observe(anchor);
    const host = position.ref.current;
    const resize = new ResizeObserver(() => {
      if (host) host.style.minHeight = `${anchor.getBoundingClientRect().height}px`;
    });
    resize.observe(anchor);
    return () => {
      intersection.disconnect();
      resize.disconnect();
    };
  }, [active, mounted, position.ref]);

  useLayoutEffect(() => {
    if (!visible) return;
    const keydown = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
        event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || hasActiveInteractionOwner()
      ) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss();
    };
    document.addEventListener("keydown", keydown, true);
    return () => document.removeEventListener("keydown", keydown, true);
  }, [dismiss, visible]);

  function show(controlId: RailTooltipControlId, text: string, element: HTMLElement) {
    if (enabled && !hasActiveInteractionOwner()) setActive({ controlId, anchor: element, text });
  }

  function leave(next: EventTarget | null) {
    const host = position.ref.current;
    if (anchor?.matches(":hover, :focus-visible") || host?.matches(":hover")) return;
    if (next instanceof Node && (anchor?.contains(next) || host?.contains(next))) return;
    dismiss();
  }

  return {
    trigger(controlId: RailTooltipControlId, text: string) {
      return {
        "aria-describedby": visible && active?.controlId === controlId ? id : undefined,
        onPointerEnter: (event: PointerEvent<HTMLElement>) => {
          if (event.pointerType !== "touch") show(controlId, text, event.currentTarget);
        },
        onPointerLeave: (event: PointerEvent<HTMLElement>) => leave(event.relatedTarget),
        onFocus: (event: FocusEvent<HTMLElement>) => {
          if (event.currentTarget.matches(":focus-visible")) show(controlId, text, event.currentTarget);
        },
        onBlur: (event: FocusEvent<HTMLElement>) => leave(event.relatedTarget),
      };
    },
    dismiss,
    tooltip: mounted && active && container ? createPortal(
      <div
        ref={(node) => {
          position.ref.current = node;
          // Set before placement measures the host, so the corridor covers the entire edge.
          if (node) node.style.minHeight = `${active.anchor.getBoundingClientRect().height}px`;
        }}
        className={styles.tooltipHost}
        style={position.style}
        onPointerLeave={(event) => leave(event.relatedTarget)}
      >
        <div id={id} role="tooltip" className={styles.tooltip}>{active.text}</div>
      </div>,
      container,
    ) : null,
  };
}
