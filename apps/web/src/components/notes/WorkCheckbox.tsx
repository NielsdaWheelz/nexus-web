"use client";

import {useState} from "react";
import type {ResourceProjection} from "@nexus/authored/types";
import {WorkConversionError, WorkUnavailableError} from "@nexus/authored/types";
import type {OutlineHistory} from "@/lib/notes/structure";
import {workCommand} from "@/lib/notes/work";
import {localResourceLabel} from "@/lib/resources/localResource";
import {useOutcome} from "@/components/feedback/Feedback";
import {workHistoryKey} from "@/lib/notes/useWorkHistoryKeys";
import {useRenderEnvironment} from "@/lib/renderEnvironment/provider";
import styles from "./WorkCheckbox.module.css";

export default function WorkCheckbox({resource,today,history,onCompleted}: {
  resource:ResourceProjection; today:string; history:OutlineHistory; onCompleted?:()=>void;
}) {
  const [busy,setBusy] = useState(false), [defect,setDefect] = useState<{error:unknown}|null>(null);
  const {say} = useOutcome();
  const {platform} = useRenderEnvironment();
  if (defect) throw defect.error;
  const work = resource.work;
  if (resource.kind !== "note" || !work?.designation.enabled) return null;
  const habit = work.designation.kind === "habit";
  const checked = habit ? work.habit_dates.includes(today) : work.task_completed_on !== null;
  const action = habit ? checked ? "clear today's check" : "mark done today" : checked ? "reopen" : "complete";
  return <input type="checkbox" className={styles.checkbox} checked={checked} aria-disabled={busy}
    aria-label={`${action}: ${localResourceLabel(resource)}`} data-row-focusable="true"
    onPointerDown={event => {if (event.button === 0) event.preventDefault(); event.stopPropagation();}}
    onKeyDown={event => {workHistoryKey(history,event.nativeEvent,platform); event.stopPropagation();}} onClick={event => {
      event.stopPropagation();
      if (busy) {event.preventDefault(); return;}
      const target = event.currentTarget, keyboard = event.detail === 0;
      const owned = document.activeElement === target;
      setBusy(true);
      void workCommand(history, habit ? {kind:"set_habit_completion",ref:resource.ref,local_date:today,completed:!checked,today}
        : {kind:"set_task_completion",ref:resource.ref,local_date:checked ? null : today,today}).then(() => {
          if (!checked && keyboard && owned && (document.activeElement === target || !target.isConnected && document.activeElement === document.body)) onCompleted?.();
        }, error => {
          if (error instanceof WorkConversionError || error instanceof WorkUnavailableError) say({fact:error.message}); else setDefect({error});
        }).finally(() => setBusy(false));
    }} onChange={() => {}}/>;
}
