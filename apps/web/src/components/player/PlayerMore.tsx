"use client";

import { useRef, useState, type RefObject } from "react";
import ActionMenu from "@/components/ui/ActionMenu";
import OverflowMenuButton from "@/components/ui/OverflowMenuButton";
import { assertNever } from "@/lib/assertNever";
import type { BarKey } from "@/lib/player/barModel";
import { usePlayerPresentation } from "@/lib/player/presentation";
import * as Player from "@/lib/player/playerRuntime";
import type { ActionDescriptor, PreparationState } from "@/lib/ui/actionDescriptor";
import * as Icon from "@/lib/ui/icons";
import type { ReturnFocusTarget } from "@/lib/ui/overlay";
import { useLatestWorkspace } from "@/lib/workspace/store";

/** The keys a narrow bar sheds, in bar order. */
export type Shed = Extract<BarKey, "previous" | "next" | "chapters" | "upNext">;
const SHED: readonly Shed[] = ["previous", "next", "chapters", "upNext"];

/**
 * More: each key the mode offers that the bar has shed at its width, then stop, hide and open
 * episode. Which keys are shed is read from their rects when the menu opens, since the menu is a
 * portal beyond the bar's container queries. Its subject leaves out the load, so a load never
 * invalidates an open menu, and open episode reads the live episode when chosen.
 */
export default function PlayerMore({ keys, shedRefs, onChapters, onUpNext, onOpened, triggerRef, returnFocusTo, className }: {
  readonly keys: ReadonlyMap<BarKey, "Enabled" | "Disabled">;
  readonly shedRefs: Readonly<Record<Shed, RefObject<HTMLElement | null>>>;
  readonly onChapters: () => void;
  readonly onUpNext: () => void;
  readonly onOpened: () => void;
  readonly triggerRef: (node: HTMLButtonElement | null) => void;
  readonly returnFocusTo: ReturnFocusTarget;
  readonly className: string;
}) {
  const commands = Player.usePlayerCommands();
  const { state } = Player.usePlayerSession();
  const presentation = usePlayerPresentation();
  const latestWorkspace = useLatestWorkspace();
  const episode = useRef<string | null>(null);
  episode.current = state.kind === "Loaded" ? state.source.descriptor.media_id : null;
  const [shed, setShed] = useState<{ readonly request: AbortSignal; readonly keys: readonly Shed[] } | null>(null);
  const row = (key: Shed): ActionDescriptor => {
    const disabled = keys.get(key) !== "Enabled";
    switch (key) {
      case "previous": return { kind: "command", id: key, label: "previous", icon: <Icon.Previous />, disabled, onSelect: commands.previous };
      case "next": return { kind: "command", id: key, label: "next", icon: <Icon.Next />, disabled, onSelect: commands.next };
      case "chapters": return { kind: "command", id: key, label: "chapters", icon: <Icon.Chapters />, hasPopup: "dialog", disabled, onSelect: onChapters };
      case "upNext": return { kind: "command", id: key, label: "up next", icon: <Icon.UpNext />, hasPopup: "dialog", disabled, onSelect: onUpNext };
      default: return assertNever(key);
    }
  };
  const prepared: PreparationState = shed === null ? null : { kind: "Ready", request: shed.request, content: { sections: [{ id: "player", label: null, options: [
    ...shed.keys.map(row),
    { kind: "command", id: "stop", label: "stop playback", icon: <Icon.Stop />, separatorBefore: shed.keys.length > 0 || undefined, onSelect: commands.stop },
    { kind: "command", id: "hide", label: "hide player", icon: <Icon.Hide />, onSelect: presentation.hide },
    { kind: "command", id: "open", label: "open episode", icon: null, onSelect: ({ openIntent }) => {
      if (episode.current === null) return;
      const workspace = latestWorkspace();
      workspace.activateWorkspaceTarget({ target: { href: `/media/${episode.current}` }, originPaneId: workspace.state.active_primary_pane_id,
        disposition: { kind: openIntent === "new_pane" ? "Fork" : "Follow" } });
      onOpened();
    } },
  ] }] } };
  return <ActionMenu label="more player actions" placement="above" triggerDisabled={keys.get("more") === "Disabled"}
    triggerRef={triggerRef} returnFocusTo={returnFocusTo}
    source={{ kind: "Prepared", subjectKey: "player", title: "player actions", initial: { sections: [] }, state: prepared,
      prepare: request => setShed({ request, keys: SHED.filter(key => keys.has(key) && shedRefs[key].current?.getClientRects().length === 0) }) }}
    renderTrigger={binding => <OverflowMenuButton {...binding} className={className} />} />;
}
