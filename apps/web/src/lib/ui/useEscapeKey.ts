"use client";

import { useEffect, useRef } from "react";
import {
  getTopmostModalLayerToken,
  type ModalLayerToken,
} from "@/lib/ui/useModalLayer";

interface EscapeOwner {
  readonly token: object;
  readonly callbackRef: { current: () => void };
  readonly isEligibleRef: { current: () => boolean };
  readonly layer: "modal" | "transient";
  readonly modalToken: ModalLayerToken | null;
  readonly scope: string | undefined;
}

const owners: EscapeOwner[] = [];
const ALWAYS_ELIGIBLE = () => true;

function topmostOwner(): EscapeOwner | undefined {
  const topModalToken = getTopmostModalLayerToken();
  if (topModalToken) {
    return (
      owners.findLast(
        (candidate) =>
          candidate.modalToken === topModalToken &&
          candidate.layer === "transient" &&
          candidate.isEligibleRef.current(),
      ) ??
      owners.findLast(
        (candidate) =>
          candidate.modalToken === topModalToken &&
          candidate.isEligibleRef.current(),
      )
    );
  }
  return owners.findLast(
    (candidate) =>
      candidate.modalToken === null && candidate.isEligibleRef.current(),
  );
}

function handleKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
  const owner = topmostOwner();
  if (!owner) return;
  event.preventDefault();
  owner.callbackRef.current();
}

/**
 * While `active`, call `onEscape` when the user presses Escape (captured at the
 * document level, with preventDefault). One shared listener dispatches to the
 * top interaction owner, so nested overlays close exactly one layer. Transient
 * owners (menus, comboboxes, popovers) outrank their containing modal; peers
 * remain activation-ordered. The handler is read through a ref.
 */
export function useEscapeKey(
  active: boolean,
  onEscape: () => void,
  options: {
    readonly layer: "modal" | "transient";
    readonly modalToken: ModalLayerToken | null;
    readonly scope?: string;
    /** Read at dispatch time; false lets the arbiter consider the next owner. */
    readonly isEligible?: () => boolean;
  },
): void {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;
  const isEligibleRef = useRef(options.isEligible ?? ALWAYS_ELIGIBLE);
  isEligibleRef.current = options.isEligible ?? ALWAYS_ELIGIBLE;
  const tokenRef = useRef<object | null>(null);
  if (tokenRef.current === null) tokenRef.current = {};
  const token = tokenRef.current;

  useEffect(() => {
    if (!active) return;
    owners.push({
      token,
      callbackRef: onEscapeRef,
      isEligibleRef,
      layer: options.layer,
      modalToken: options.modalToken,
      scope: options.scope,
    });
    if (owners.length === 1) {
      document.addEventListener("keydown", handleKeyDown);
    }
    return () => {
      const index = owners.findIndex((owner) => owner.token === token);
      if (index < 0) {
        throw new Error("Active Escape owner was not registered.");
      }
      owners.splice(index, 1);
      if (owners.length === 0) {
        document.removeEventListener("keydown", handleKeyDown);
      }
    };
  }, [active, options.layer, options.modalToken, options.scope, token]);
}

/** Whether any modal/transient interaction currently owns global commands. */
export function hasActiveInteractionOwner(): boolean {
  return topmostOwner() !== undefined;
}

/** True only when the named modal is above every modal/transient owner. */
export function isTopmostInteractionOwner(scope: string): boolean {
  return topmostOwner()?.scope === scope;
}
