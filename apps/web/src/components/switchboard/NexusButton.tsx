"use client";

import {
  useCallback,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { flushSync } from "react-dom";
import AsterismMark from "@/components/AsterismMark";
import { useMobileViewport } from "@/lib/mobileViewport/MobileViewportProvider";
import {
  useMobileChrome,
  useMobileChromeSurface,
} from "@/lib/workspace/mobileChrome";
import {
  beginNexusPerformance,
  NEXUS_OPEN_PERFORMANCE,
} from "@/lib/nexus/performance";
import type { WorkspaceAdjacentPaneDirection } from "@/lib/workspace/store";
import styles from "./switchboard.module.css";

const TOUCH_MOVEMENT_SLOP_PX = 8;
// Native input projection can undershoot a nominal CSS-pixel boundary by a
// few floating-point ulps (for example, 7.999969px for an 8px movement).
const TOUCH_MOVEMENT_SLOP_EPSILON_PX = 0.001;
const TOUCH_HORIZONTAL_LOCK_RATIO = 1.5;
const TOUCH_COMMIT_DISPLACEMENT_PX = 20;

type TouchPointerAxisState = "Idle" | "Tracking" | "Locked" | "Yielded";

interface TouchPointerOrigin {
  readonly x: number;
  readonly y: number;
}

export default function NexusButton({
  paneCount,
  switchboardOpen,
  onOpen,
  onActivateAdjacentPane,
  onButtonNodeChange,
}: {
  paneCount: number;
  switchboardOpen: boolean;
  onOpen: (opener: HTMLButtonElement) => void;
  onActivateAdjacentPane: (input: {
    readonly direction: WorkspaceAdjacentPaneDirection;
  }) => void;
  onButtonNodeChange?: (node: HTMLButtonElement | null) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const setButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      buttonRef.current = node;
      onButtonNodeChange?.(node);
    },
    [onButtonNodeChange],
  );
  const mobileViewport = useMobileViewport();
  const { motionPhase } = useMobileChrome();
  const motionInert =
    motionPhase.kind !== "Visible" && motionPhase.kind !== "Pinned";
  const axisStateRef = useRef<TouchPointerAxisState>("Idle");
  const pointerIdRef = useRef<number | null>(null);
  const originRef = useRef<TouchPointerOrigin | null>(null);
  const suppressNextPointerClickRef = useRef(false);
  const mountedRef = useRef(false);
  const operabilityRef = useRef({ switchboardOpen, motionInert });
  const resetTrackedPointer = useCallback(() => {
    axisStateRef.current = "Idle";
    pointerIdRef.current = null;
    originRef.current = null;
  }, []);
  const isButtonOperable = useCallback(() => {
    const operability = operabilityRef.current;
    return (
      mountedRef.current &&
      !operability.switchboardOpen &&
      !operability.motionInert
    );
  }, []);
  useMobileChromeSurface(buttonRef, "NexusControl", true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      resetTrackedPointer();
    };
  }, [resetTrackedPointer]);
  useLayoutEffect(() => {
    operabilityRef.current = { switchboardOpen, motionInert };
    if (switchboardOpen || motionInert) {
      if (axisStateRef.current !== "Idle") {
        suppressNextPointerClickRef.current = true;
      }
      resetTrackedPointer();
    }
  }, [motionInert, resetTrackedPointer, switchboardOpen]);
  useLayoutEffect(() => {
    const element = wrapperRef.current;
    if (switchboardOpen || !element) return;
    return mobileViewport.registerBottomSurface("Nexus", element);
  }, [mobileViewport, switchboardOpen]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (axisStateRef.current !== "Idle") {
      suppressNextPointerClickRef.current = true;
      resetTrackedPointer();
      return;
    }
    suppressNextPointerClickRef.current = false;
    if (
      !event.isPrimary ||
      event.pointerType !== "touch" ||
      !isButtonOperable()
    ) {
      return;
    }

    axisStateRef.current = "Tracking";
    pointerIdRef.current = event.pointerId;
    originRef.current = { x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const axisState = axisStateRef.current;
    if (axisState === "Idle" || pointerIdRef.current !== event.pointerId)
      return;
    const origin = originRef.current;
    if (!origin) return;

    const displacement = {
      dx: event.clientX - origin.x,
      dy: event.clientY - origin.y,
    };
    if (
      axisState !== "Tracking" ||
      Math.hypot(displacement.dx, displacement.dy) +
        TOUCH_MOVEMENT_SLOP_EPSILON_PX <
        TOUCH_MOVEMENT_SLOP_PX
    ) {
      return;
    }

    suppressNextPointerClickRef.current = true;
    axisStateRef.current =
      Math.abs(displacement.dx) >=
      TOUCH_HORIZONTAL_LOCK_RATIO * Math.abs(displacement.dy)
        ? "Locked"
        : "Yielded";
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const axisState = axisStateRef.current;
    if (axisState === "Idle" || pointerIdRef.current !== event.pointerId)
      return;
    const origin = originRef.current;
    const displacement = origin
      ? {
          dx: event.clientX - origin.x,
          dy: event.clientY - origin.y,
        }
      : null;
    const direction: WorkspaceAdjacentPaneDirection | null =
      axisState === "Locked" &&
      displacement !== null &&
      Math.abs(displacement.dx) >= TOUCH_COMMIT_DISPLACEMENT_PX
        ? displacement.dx < 0
          ? "Next"
          : "Previous"
        : null;

    resetTrackedPointer();
    if (direction === null || !isButtonOperable()) return;
    onActivateAdjacentPane({ direction });
  };

  const cancelTrackedPointer = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (
      axisStateRef.current === "Idle" ||
      pointerIdRef.current !== event.pointerId
    ) {
      return;
    }
    resetTrackedPointer();
  };

  const label =
    paneCount === 1 ? "Open Nexus, 1 tab" : `Open Nexus, ${paneCount} tabs`;
  return (
    <div
      ref={wrapperRef}
      className={styles.nexusWrapper}
      data-testid="nexus-wrapper"
    >
      <button
        ref={setButtonRef}
        data-nexus-return-focus
        type="button"
        className={styles.nexusButton}
        aria-label={label}
        aria-haspopup="dialog"
        aria-hidden={motionInert || switchboardOpen || undefined}
        inert={motionInert || switchboardOpen || undefined}
        data-switchboard-open={switchboardOpen || undefined}
        data-mobile-chrome-phase={motionPhase.kind}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={cancelTrackedPointer}
        onLostPointerCapture={cancelTrackedPointer}
        onClick={(event) => {
          if (event.detail > 0 && suppressNextPointerClickRef.current) {
            suppressNextPointerClickRef.current = false;
            return;
          }
          beginNexusPerformance(NEXUS_OPEN_PERFORMANCE);
          flushSync(() => onOpen(event.currentTarget));
        }}
      >
        <span className={styles.nexusFace}>
          <AsterismMark className={styles.nexusMark} size={20} />
        </span>
        <span className={styles.nexusCount} aria-hidden="true">
          {paneCount}
        </span>
      </button>
    </div>
  );
}
