"use client";

import type {ResourceProjection} from "@nexus/authored/types";
import type {LocalCommit} from "@/lib/notes/runtime";
import type {OutlineHistory} from "@/lib/notes/structure";
import {useWorkCheck} from "@/lib/notes/work";
import * as Icon from "@/lib/ui/icons";
import styles from "./WorkCheckbox.module.css";

/** A work sign outside an outline row. `onCompleted` fires once a completion, never a reopening, is
 * committed. `keyboard` is the focus lease: the press came from the keys with focus on this sign, and
 * focus is still here, or fell to the body because the commit removed the sign.
 * `onCompleting` fires synchronously in the press's own event, once a completion is actually sent, with
 * toggle's promise of its local commit (null if refused); a host keeps the row before the commit can change its query.
 * `presentDone` is the host's presentation of a completion its projection has not shown yet: the sign
 * is drawn done and takes no press. The check and its command stay `useWorkCheck`'s. */
export default function WorkCheckbox({resource,today,history,presentDone = false,onCompleting,onCompleted}: {
  resource:ResourceProjection; today:string|null; history:OutlineHistory; presentDone?:boolean;
  onCompleting?:(committed:Promise<LocalCommit | null>)=>void; onCompleted?:(how:{keyboard:boolean})=>void;
}) {
  const check = useWorkCheck(resource,today,history);
  if (check === null) return null;
  const checked = presentDone || check.checked;
  return <button type="button" role="checkbox" className={styles.checkbox} aria-checked={checked} aria-disabled={presentDone || check.busy || check.disabled}
    aria-label={check.label} data-row-focusable="true"
    onPointerDown={event => {if (event.button === 0) event.preventDefault(); event.stopPropagation();}}
    onKeyDown={event => {check.onKeyDown(event); event.stopPropagation();}} onClick={event => {
      event.stopPropagation();
      if (presentDone) return;
      const target = event.currentTarget, completing = check.checked === false && !check.busy && !check.disabled;
      const leased = event.detail === 0 && document.activeElement === target;
      const committed = check.toggle();
      if (completing) onCompleting?.(committed);
      void committed.then(commit => {
        if (commit !== null && completing) onCompleted?.({keyboard: leased && (document.activeElement === target || !target.isConnected && document.activeElement === document.body)});
      });
    }}><Icon.Task checked={checked}/></button>;
}
