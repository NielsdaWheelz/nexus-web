"use client";

import { useEffect, useRef } from "react";
import * as Player from "@/lib/player/playerRuntime";
import { isEditableTarget, isInteractiveTarget } from "@/lib/ui/eventTarget";
import { hasActiveInteractionOwner } from "@/lib/ui/overlay";
import type { PlayerOrigin } from "./usePlayerOrigin";

/**
 * Space plays and pauses, ←/→ skip, shift+←/→ step the queue; never inside controls or text.
 * The listener registers once for the player's lifetime; the ref hands it each render's session.
 */
export default function PlayerKeys({ origin: _origin }: { readonly origin: PlayerOrigin }) {
  const commands = Player.usePlayerCommands();
  const { state, pendingPlayback, queue } = Player.usePlayerSession();
  const keyed = useRef({ commands, canPause: false, loaded: false });
  keyed.current = {
    commands,
    canPause: pendingPlayback !== null || (state.kind === "Loaded" && (state.phase === "Playing" || state.phase === "Buffering")),
    loaded: state.kind === "Loaded" || queue.header?.current_entry_id != null,
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const { commands: c, canPause, loaded } = keyed.current;
      const target = event.target;
      if ((!loaded && !canPause) || event.defaultPrevented || event.isComposing || hasActiveInteractionOwner()) return;
      if (event.altKey || event.ctrlKey || event.metaKey || isEditableTarget(target) || isInteractiveTarget(target)) return;
      const shortcut = `${event.shiftKey ? "Shift+" : ""}${event.code === "Space" ? "Space" : event.key}`;
      if (shortcut !== "Space" && !loaded) return;
      const action = {
        Space: canPause ? c.pause : c.resume,
        ArrowLeft: () => c.skipBy(-Player.PLAYER_SKIP_BACK_MS),
        ArrowRight: () => c.skipBy(Player.PLAYER_SKIP_FORWARD_MS),
        "Shift+ArrowLeft": c.previous,
        "Shift+ArrowRight": c.next,
      }[shortcut];
      if (action === undefined) return;
      event.preventDefault();
      action();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return null;
}
