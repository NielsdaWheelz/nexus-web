"use client";

import { useEffect, useRef } from "react";
import { readerScrollport } from "@/lib/documentReader/scrollport";
import { barMode, liveKeys } from "@/lib/player/barModel";
import { stepRate } from "@/lib/player/playbackRate";
import * as Player from "@/lib/player/playerRuntime";
import { isEditableTarget, isInteractiveTarget } from "@/lib/ui/eventTarget";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import type { PlayerOrigin } from "./usePlayerOrigin";

/** One command owner, off the clock. Native controls, readers and overlays retain their keys. */
export default function PlayerKeys({ origin }: { readonly origin: PlayerOrigin }) {
  const commands = Player.usePlayerCommands();
  const session = Player.usePlayerSession();
  // Availability does not depend on the descriptive summary used by the bar's identity.
  const mode = barMode(session, { kind: "Ready", summary: null });
  const keyed = useRef({ commands, session, mode, origin });
  keyed.current = { commands, session, mode, origin };
  const recalled = useRef(1.5);
  if (session.preferences !== null && session.preferences.rate !== 1) recalled.current = session.preferences.rate;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || hasActiveInteractionOwner() || event.altKey || event.ctrlKey || event.metaKey) return;
      const { commands: c, session: s, mode: m, origin: o } = keyed.current;
      const target = event.target;
      const inBar = target instanceof Element && target.closest("[data-player-bar]") !== null;
      const queueKey = event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight");
      const rail = inBar && target instanceof HTMLInputElement && target.type === "range";
      if (isEditableTarget(target) && !(rail && queueKey)) return;
      const keys = liveKeys(m, s);
      const port = readerScrollport(target);
      const interactive = isInteractiveTarget(target);
      const pause = s.pendingPlayback !== null || s.state.kind === "Loaded" && (s.state.phase === "Playing" || s.state.phase === "Buffering");
      let action: (() => void) | null = null;
      if (queueKey) {
        const name = event.key === "ArrowLeft" ? "previous" : "next";
        if ((!interactive || inBar) && keys.get(name) === "Enabled") action = c[name];
      } else if (event.shiftKey) return;
      else if (event.key === "k" || event.code === "Space" && !interactive && port === null) {
        if (keys.get("disc") === "Enabled") action = pause ? c.pause : c.resume;
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (port !== null) {
          if (m.kind !== "Active" || isInteractiveTarget(target, port)) return;
          const width = port.scrollWidth - port.clientWidth;
          const rtl = getComputedStyle(port).direction === "rtl";
          if (event.key === "ArrowLeft" ? port.scrollLeft > (rtl ? -width : 0) : port.scrollLeft < (rtl ? 0 : width)) return;
        } else if (interactive && !inBar) return;
        const back = event.key === "ArrowLeft";
        if (keys.get(back ? "back" : "forward") === "Enabled") action = () => c.skipBy(back ? -Player.PLAYER_SKIP_BACK_MS : Player.PLAYER_SKIP_FORWARD_MS);
      } else if (event.key === "[" || event.key === "]" || event.key === "\\") {
        if (m.kind !== "Active" || keys.get("speed") !== "Enabled" || s.preferences === null) return;
        const rate = event.key === "\\" ? s.preferences.rate === 1 ? recalled.current : 1 : stepRate(s.preferences.rate, event.key === "]" ? 1 : -1);
        if (rate !== null) action = () => c.setPlaybackRate(rate);
      } else if (event.key === "," || event.key === ".") {
        if (m.kind !== "Active" || keys.get("chapters") !== "Enabled") return;
        const at = c.readPositionMs();
        const chapters = m.loaded.source.descriptor.chapters;
        const to = event.key === "," ? chapters.findLast(chapter => chapter.start_ms < at - 3_000)?.start_ms ?? 0
          : chapters.find(chapter => chapter.start_ms > at)?.start_ms ?? null;
        if (to !== null) action = () => o.seek(to);
      } else if (event.key === "'" && o.origin !== null && keys.get("back") === "Enabled") action = o.returnToOrigin;
      if (action === null) return;
      event.preventDefault();
      action();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}
