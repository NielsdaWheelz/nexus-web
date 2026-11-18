"use client";

import type {ResourceProjection} from "@nexus/authored/types";
import type {OutlineHistory} from "@/lib/notes/structure";
import {useWorkCheck} from "@/lib/notes/work";
import * as Icon from "@/lib/ui/icons";
import styles from "./WorkCheckbox.module.css";

/** A work sign outside an outline row. `onCompleted` fires once a completion, never a reopening, is
 * committed. `keyboard` is the focus lease: the press came from the keys with focus on this sign, and
 * focus is still here, or fell to the body because the commit removed the sign. */
export default function WorkCheckbox({resource,today,history,onCompleted}: {
  resource:ResourceProjection; today:string|null; history:OutlineHistory; onCompleted?:(how:{keyboard:boolean})=>void;
}) {
  const check = useWorkCheck(resource,today,history);
  if (check === null) return null;
  return <button type="button" role="checkbox" className={styles.checkbox} aria-checked={check.checked} aria-disabled={check.busy || check.disabled}
    aria-label={check.label} data-row-focusable="true"
    onPointerDown={event => {if (event.button === 0) event.preventDefault(); event.stopPropagation();}}
    onKeyDown={event => {check.onKeyDown(event); event.stopPropagation();}} onClick={event => {
      event.stopPropagation();
      const target = event.currentTarget, completing = check.checked === false;
      const leased = event.detail === 0 && document.activeElement === target;
      void check.toggle().then(committed => {
        if (committed && completing) onCompleted?.({keyboard: leased && (document.activeElement === target || !target.isConnected && document.activeElement === document.body)});
      });
    }}><Icon.Task checked={check.checked}/></button>;
}
