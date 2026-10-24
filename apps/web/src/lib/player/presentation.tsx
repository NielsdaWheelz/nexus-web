"use client";

/**
 * Account-lifetime desktop visibility, independent of playback and mobile chrome.
 * Only explicit choices write the tab's optional session preference. Rail-open
 * focus waits for the visible region's commit; later commands retire that request.
 */
import {
  createContext,
  useCallback,
  useContext,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { getInteractionOwner } from "@/lib/ui/overlay";

interface PlayerPresentation {
  visible: boolean;
  show(options: { focus: boolean }): void;
  hide(): void;
  regionId: string;
  railRef: RefObject<HTMLButtonElement | null>;
  regionRef: RefObject<HTMLElement | null>;
}

const PlayerPresentationContext = createContext<PlayerPresentation | null>(null);

export function PlayerPresentationProvider({ accountId, children }: { accountId: string; children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const regionId = useId();
  const railRef = useRef<HTMLButtonElement>(null);
  const regionRef = useRef<HTMLElement>(null);
  const explicitChoice = useRef(false);
  const focusRequested = useRef(false);
  const storageKey = `nexus:desktop-player:${accountId}`;

  useLayoutEffect(() => {
    if (!explicitChoice.current) {
      let shown = true;
      try { shown = window.sessionStorage.getItem(storageKey) !== "hidden"; }
      catch { /* Visibility remains usable when optional browser storage is denied. */ }
      setVisible(shown);
    }
    return () => { focusRequested.current = false; };
  }, [storageKey]);

  const chooseVisibility = useCallback((shown: boolean) => {
    explicitChoice.current = true;
    setVisible(shown);
    try { window.sessionStorage.setItem(storageKey, shown ? "shown" : "hidden"); }
    catch { /* This tab keeps its in-memory choice when storage is denied. */ }
  }, [storageKey]);

  const show = useCallback(({ focus }: { focus: boolean }) => {
    focusRequested.current = focus;
    chooseVisibility(true);
  }, [chooseVisibility]);

  const hide = useCallback(() => {
    focusRequested.current = false;
    const region = regionRef.current;
    const active = document.activeElement;
    const layer = getInteractionOwner();
    const opener = layer?.opener;
    const openerElement = opener instanceof HTMLElement ? opener : opener?.element ?? null;
    const portalFocused = region !== null && openerElement !== null && region.contains(openerElement)
      && layer?.options.current.inside?.().some(element => element?.contains(active));
    if (region?.contains(active) || portalFocused) railRef.current?.focus({ preventScroll: true });
    chooseVisibility(false);
  }, [chooseVisibility]);

  useLayoutEffect(() => {
    if (!visible || !focusRequested.current) return;
    focusRequested.current = false;
    regionRef.current?.focus({ preventScroll: true });
  }, [visible]);

  const value = useMemo(() => ({ visible, show, hide, regionId, railRef, regionRef }), [visible, show, hide, regionId]);
  return <PlayerPresentationContext value={value}>{children}</PlayerPresentationContext>;
}

export function usePlayerPresentation(): PlayerPresentation {
  const value = useContext(PlayerPresentationContext);
  if (value === null) throw new Error("usePlayerPresentation requires PlayerPresentationProvider");
  return value;
}
