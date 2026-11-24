"use client";

import type {WorkIndexItem} from "@nexus/authored/types";
import type {OutlineHistory} from "@/lib/notes/structure";
import {useWorkCheck, type WorkIntent} from "@/lib/notes/work";
import * as Icon from "@/lib/ui/icons";
import styles from "./WorkCheckbox.module.css";

/** A press on a work sign that completes, handed to a host that outlives the sign. `at` is the input's own
 * timestamp, on `performance.now()`'s clock. `keyboard`: the keys pressed it with focus on this sign. */
export interface WorkCompletion { intent: WorkIntent; keyboard: boolean; at: number }

/** A work sign outside an outline row. What a press sends is `useWorkCheck`'s.
 * `onComplete`: a completing press is the host's. The sign sends nothing itself; the host sends `intent` and owns
 * its outcome, so a refusal or defect is not lost when the sign unmounts. A reopening press stays the sign's.
 * `presentDone`: the host's presentation of a completion its projection has not shown yet. The sign is drawn
 * done, is named for what it shows (`completed: {line}`), and takes no press. */
export default function WorkCheckbox({resource,today,history,presentDone = false,onComplete}: {
  resource:WorkIndexItem; today:string|null; history:OutlineHistory; presentDone?:boolean;
  onComplete?:(completion:WorkCompletion)=>void;
}) {
  const label = resource.label === null ? "name too large to display" : resource.label || "empty note";
  const check = useWorkCheck({...resource, label},today,history);
  if (check === null) return null;
  const checked = presentDone || check.checked;
  return <button type="button" role="checkbox" className={styles.checkbox} aria-checked={checked} aria-disabled={presentDone || check.busy || check.disabled}
    aria-label={presentDone ? `completed: ${label}` : check.label} data-row-focusable="true"
    onPointerDown={event => {if (event.button === 0) event.preventDefault(); event.stopPropagation();}}
    onKeyDown={event => {check.onKeyDown(event); event.stopPropagation();}} onClick={event => {
      event.stopPropagation();
      if (presentDone || check.intent === null) return;
      if (onComplete && check.checked === false) {
        onComplete({intent: check.intent, keyboard: event.detail === 0 && document.activeElement === event.currentTarget, at: event.timeStamp});
        return;
      }
      void check.toggle();
    }}><Icon.Task checked={checked}/></button>;
}
