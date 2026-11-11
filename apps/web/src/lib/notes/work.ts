"use client";

/** Work surfaces borrow the same visit history as their writing. No separate writer. */
import {createContext, useLayoutEffect, useContext, useState} from "react";
import type {Intent} from "@nexus/authored/commands";
import {WorkConversionError, WorkUnavailableError} from "@nexus/authored/types";
import {useOutcome} from "@/components/feedback/Feedback";
import {useActionRuntime} from "@/lib/actions/ResourceActionsProvider";
import {findPaneLandmarkFocusTarget} from "@/lib/workspace/paneDom";
import {useWritingRuntime} from "./hooks";
import {LocalCommitError} from "./runtime";
import {OutlineHistory} from "./structure";
import {OutlineHistoryAllowance} from "./outlineHistoryAllowance";
import {useWorkHistoryKeys} from "./useWorkHistoryKeys";

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

export async function workCommand(history: OutlineHistory, intent: WorkIntent): Promise<void> {
  try {await history.work(intent).result;}
  catch (error) {if (error instanceof LocalCommitError) await error.completion; else throw error;}
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
