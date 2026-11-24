"use client";

/** Work surfaces borrow the same visit history as their writing. No separate writer. */
import {createContext, useLayoutEffect, useContext, useState, type KeyboardEvent} from "react";
import type {Intent} from "@nexus/authored/commands";
import type {ResourceProjection} from "@nexus/authored/types";
import {WorkConversionError, WorkUnavailableError} from "@nexus/authored/types";
import {useOutcome} from "@/components/feedback/Feedback";
import {useActionRuntime} from "@/lib/actions/ResourceActionsProvider";
import {useRenderEnvironment} from "@/lib/renderEnvironment/provider";
import {findPaneLandmarkFocusTarget} from "@/lib/workspace/paneDom";
import {ACCOUNT_DAY_UNAVAILABLE} from "./accountDay";
import {useWritingRuntime} from "./hooks";
import {LocalCommitError, type LocalCommit} from "./runtime";
import {OutlineHistory} from "./structure";
import {OutlineHistoryAllowance} from "./outlineHistoryAllowance";
import {useWorkHistoryKeys, workHistoryKey} from "./useWorkHistoryKeys";

export type WorkIntent = Extract<Intent, {kind:"set_work_designation"|"set_task_completion"|"set_habit_completion"|"clear_work_day"}>;
export const WorkHistoryContext = createContext<OutlineHistory | null>(null);
export const WorkOverlayContext = createContext<string | null>(null);

export function useWorkHistory(suppliedAllowance?: OutlineHistoryAllowance): {history: OutlineHistory | null; error: unknown | null} {
  const runtime = useWritingRuntime(), {say} = useOutcome();
  const [ownAllowance] = useState(() => new OutlineHistoryAllowance());
  const allowance = suppliedAllowance ?? ownAllowance;
  const [history, setHistory] = useState<OutlineHistory | null>(null);
  const [error, setError] = useState<unknown | null>(null);
  const [, changed] = useState(0);
  useWorkHistoryKeys(history);
  useLayoutEffect(() => {
    if (runtime === null) return;
    const owner = new OutlineHistory(runtime, error => {
      if (error instanceof WorkConversionError) say({fact:"use a new note to change work type while completion history exists."});
      else if (error instanceof WorkUnavailableError) say({fact:error.message});
      else if (!(error instanceof LocalCommitError)) setError(error);
    }, allowance, () => changed(value => value + 1));
    setHistory(owner);
    return () => {owner.close(); setHistory(current => current === owner ? null : current);};
  }, [runtime, allowance, say]);
  return {history,error};
}

/** Runs one work command; resolves with its local commit once it is durable on this device. */
export async function workCommand(history: OutlineHistory, intent: WorkIntent): Promise<LocalCommit> {
  try {return await history.work(intent).result;}
  catch (error) {if (error instanceof LocalCommitError) return await error.completion; throw error;}
}

/** Runs one work command for its owner: resolves with the durable commit, or null once a refusal has been said.
 * Anything else is a defect and rejects; the owner throws it from its own render. */
export async function tryWorkCommand(history: OutlineHistory, intent: WorkIntent, say: ReturnType<typeof useOutcome>["say"]): Promise<LocalCommit | null> {
  try {return await workCommand(history, intent);}
  catch (error) {
    if (!(error instanceof WorkConversionError || error instanceof WorkUnavailableError)) throw error;
    say({fact: error.message});
    return null;
  }
}

export interface WorkCheck {
  /** `mixed`: a habit whose day is unknown. */
  checked: boolean | "mixed";
  label: string;
  /** The account day is unknown: a press does nothing. */
  disabled: boolean;
  busy: boolean;
  /** What a press sends now; null when a press does nothing (the day unknown, or a press in flight). */
  intent: WorkIntent | null;
  /** Completes or reopens. Resolves with the local commit once that change is durable on this device, null
   * when it was refused or not attempted; a defect is thrown at the caller's next render. */
  toggle(): Promise<LocalCommit | null>;
  /** A checkbox ignores Enter; the work-history keys run from the sign. */
  onKeyDown(event: KeyboardEvent): void;
}

/** The one owner of what a press on a work sign does. Null when the resource is not designated work. */
export function useWorkCheck({ref, work, label}: {ref: string; work: ResourceProjection["work"]; label: string}, today: string | null, history: OutlineHistory): WorkCheck | null {
  const [busy, setBusy] = useState(false), [defect, setDefect] = useState<{error: unknown} | null>(null);
  const {say} = useOutcome();
  const {platform} = useRenderEnvironment();
  if (defect) throw defect.error;
  if (!work?.designation.enabled) return null;
  const habit = work.designation.kind === "habit";
  const done = habit ? today !== null && work.habit_dates.includes(today) : work.task_completed_on !== null;
  const action = habit ? done ? "clear today's check" : "mark done today" : done ? "reopen" : "complete";
  const intent: WorkIntent | null = busy || today === null ? null
    : habit ? {kind: "set_habit_completion", ref, local_date: today, completed: !done, today}
    : {kind: "set_task_completion", ref, local_date: done ? null : today, today};
  return {
    checked: habit && today === null ? "mixed" : done, disabled: today === null, busy, intent,
    label: today === null ? `${ACCOUNT_DAY_UNAVAILABLE} ${label}` : `${action}: ${label}`,
    toggle: async () => {
      if (intent === null) return null;
      setBusy(true);
      try {return await tryWorkCommand(history, intent, say);}
      catch (error) {setDefect({error}); return null;}
      finally {setBusy(false);}
    },
    onKeyDown: event => {
      if (event.key === "Enter") event.preventDefault();
      workHistoryKey(history, event.nativeEvent, platform);
    },
  };
}

export function useOpenHabitHistory(): (ref: string, local_date: string, history: OutlineHistory) => void {
  const {ctx} = useActionRuntime();
  return (ref, local_date, history) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const year = opener?.matches('[data-date]') ? opener.closest('[role="group"]') : null;
    const row = opener?.closest('[data-collection-row-id]');
    const paneId = opener?.closest<HTMLElement>('[data-pane-id]')?.dataset.paneId ?? null;
    ctx.overlays.open({kind:"HabitHistory",ref,local_date,history}, {
      anchor: () => opener?.isConnected && !opener.matches(':disabled') ? opener : null,
      returnFocusFallback: () => year?.isConnected ? year.querySelector<HTMLElement>('button[tabindex="0"]:not(:disabled)')
        ?? row?.querySelector<HTMLElement>('[data-habit-history]:not(:disabled)') ?? findPaneLandmarkFocusTarget(paneId) : findPaneLandmarkFocusTarget(paneId),
    });
  };
}

export function useInvokingWorkHistory(): OutlineHistory | null {return useContext(WorkHistoryContext);}
