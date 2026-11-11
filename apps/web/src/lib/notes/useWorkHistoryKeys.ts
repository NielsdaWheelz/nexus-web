"use client";

import {useEffect} from "react";
import {outlineHistoryCommand} from "@/lib/shortcuts";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import {useLatestWorkspace} from "@/lib/workspace/store";
import {useRenderEnvironment} from "@/lib/renderEnvironment/provider";
import type {PlatformKind} from "@/lib/renderEnvironment/types";
import type {OutlineHistory} from "./structure";

export function workHistoryKey(history: OutlineHistory, event: Pick<KeyboardEvent,"target"|"key"|"shiftKey"|"metaKey"|"ctrlKey"|"altKey"|"repeat"|"isComposing"|"defaultPrevented"|"preventDefault">, platform:PlatformKind): void {
  if (event.defaultPrevented || event.isComposing || !(event.target instanceof Element)) return;
  const target = event.target;
  if (target.closest('textarea,select,input:not([type="checkbox"])') || target.closest('[contenteditable="true"]') && !target.closest('button,input,[contenteditable="false"]')) return;
  const command = outlineHistoryCommand(event,platform);
  if (command === null) return;
  event.preventDefault();
  if (!event.repeat) {if (command === "undo") history.undo(); else history.redo();}
}

/** A visit's non-text controls retain access to its history after a row leaves. */
export function useWorkHistoryKeys(history: OutlineHistory | null): void {
  const pane = usePaneRuntime(), workspace = useLatestWorkspace(), {platform} = useRenderEnvironment();
  const paneId = pane?.paneId, visitId = pane?.visitId;
  useEffect(() => {
    if (!history || !paneId) return;
    const key = (event:KeyboardEvent) => {
      if (!(event.target instanceof Element) || event.target.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId !== paneId) return;
      if (workspace().state.panes.find(pane => pane.id === paneId)?.current_visit.id !== visitId) return;
      workHistoryKey(history,event,platform);
    };
    document.addEventListener("keydown",key);
    return () => document.removeEventListener("keydown",key);
  }, [history,paneId,visitId,workspace,platform]);
}
