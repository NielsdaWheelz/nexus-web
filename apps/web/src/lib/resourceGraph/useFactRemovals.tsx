"use client";

// A visit owns its server-fact removals independently of filtered/folded rows.
// Sending and unknown commands hold the loss guard synchronously. Only accepted
// identical removal or a permanent context-version fence settles an unknown;
// row absence is never evidence. Local authored unlinks keep their own owner.
import {createContext} from "react";
import {Hold, useOutcome, useResendFeedback} from "@/components/feedback/Feedback";
import type {Retract} from "@/components/feedback/stage";
import {useActionRuntime} from "@/lib/actions/ResourceActionsProvider";
import {isApiError, outcomeUnknown} from "@/lib/api/client";
import {UNKNOWN_OUTCOME_REASON} from "@/lib/api/failure";
import {handleUnauthenticatedApiError} from "@/lib/auth/UnauthenticatedApiBoundary";
import {useWritingRuntime} from "@/lib/notes/hooks";
import {resolvePaneRouteModel} from "@/lib/panes/paneRouteModel";
import {mutateConnection, type ConnectionCommand} from "./links";
import {useResourceDraft} from "./useResourceDraft";
import {usePaneVisitWorkScope} from "@/lib/workspace/paneReturnMemento";
import {useLatestWorkspace, useSubscribeWorkspace} from "@/lib/workspace/store";

export type FactRemovalCommand = Exclude<ConnectionCommand, {kind: "unlink"}>;
interface Removal {
  readonly key: string;
  readonly command: FactRemovalCommand;
  readonly settled: (untouched: boolean) => void;
  running: boolean;
  unknown: number;
  report: Retract | null;
}

export function useFactRemovals(scopeName: string) {
  const {ctx} = useActionRuntime();
  const writing = useWritingRuntime();
  const scope = usePaneVisitWorkScope();
  const workspace = useLatestWorkspace();
  const subscribeWorkspace = useSubscribeWorkspace();
  const outcome = useOutcome();
  const resendFeedback = useResendFeedback();
  const owner = useResourceDraft<ReadonlyMap<string, Removal>>(`FactRemovals:${scopeName}`, () => new Map(), removals => ({
    changed: false,
    unconfirmed: [...removals.values()].some(removal => removal.running || removal.unknown > 0),
    stopsBrowserWork: [...removals.values()].some(removal => removal.running),
  }));
  const account = ctx.sessionSignal();
  const ownsVisit = () => !account.aborted && workspace().state.panes.some(pane =>
    [pane.current_visit, ...pane.history.back, ...pane.history.forward].some(visit =>
      visit.id === scope.visitId && resolvePaneRouteModel(visit.href).routeKey === scope.routeKey));
  const publish = () => owner.set(current => new Map(current));
  const forget = (removal: Removal) => owner.set(current => {
    if (current.get(removal.key) !== removal) return current;
    removal.report?.(); removal.report = null;
    const next = new Map(current); next.delete(removal.key); return next;
  });
  const retry = (removal: Removal) => ({
    label: "retry", commandKey: `Resource.Relation.retry:${owner.owner}:${removal.key}`,
    run: () => {
      if (owner.read().get(removal.key) === removal) void run(removal);
    },
    busy: removal.running,
  });
  async function run(removal: Removal) {
    if (!ownsVisit() || writing === null || removal.running || owner.read().get(removal.key) !== removal) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    account.addEventListener("abort", abort, {once: true});
    const stop = subscribeWorkspace(() => { if (!ownsVisit()) controller.abort(); });
    const current = () => !controller.signal.aborted && ownsVisit() && owner.read().get(removal.key) === removal;
    let untouched = true;
    const touched = () => { untouched = false; };
    document.addEventListener("pointerdown", touched, true);
    document.addEventListener("keydown", touched, true);
    removal.running = true;
    removal.report?.(); removal.report = null;
    publish();
    try {
      await mutateConnection(writing, removal.command, controller.signal);
      if (!current()) return;
      forget(removal);
      removal.settled(untouched);
    } catch (error) {
      if (!current()) return;
      if (outcomeUnknown(error)) { removal.unknown++; publish(); return; }
      // This endpoint serializes against context writes and compares a monotone
      // version. The old command cannot apply after this permanent fence.
      if (removal.command.kind === "detach_context" && isApiError(error) && error.code === "E_CONTEXT_CHANGED") {
        forget(removal);
        removal.report = outcome.say({fact: "couldn’t remove this from future context.", reason: "the context changed."});
        removal.settled(false);
        return;
      }
      if (removal.unknown > 0) removal.unknown++;
      publish();
      if (!handleUnauthenticatedApiError(error))
        removal.report = outcome.fail(error, "couldn’t remove this connection.", retry(removal));
    } finally {
      document.removeEventListener("pointerdown", touched, true);
      document.removeEventListener("keydown", touched, true);
      stop();
      account.removeEventListener("abort", abort);
      removal.running = false;
      if (current()) publish();
    }
  }
  return {
    pending: owner.value,
    remove(key: string, command: FactRemovalCommand, settled: (untouched: boolean) => void) {
      if (!ownsVisit() || writing === null) return;
      const existing = owner.read().get(key);
      if (existing?.running || existing && existing.unknown > 0) { void run(existing); return; }
      if (existing) forget(existing);
      const removal: Removal = {key, command, settled, running: false, unknown: 0, report: null};
      owner.set(current => new Map(current).set(key, removal));
      void run(removal);
    },
    holds: [...owner.value.values()].filter(removal => removal.unknown > 0).map(removal =>
      <Hold key={removal.key} id={`Resource.Relation.removal:${owner.owner}:${removal.key}`} attempt={removal.unknown}
        {...resendFeedback({line: {fact: "not sure that was removed.", reason: UNKNOWN_OUTCOME_REASON}, resend: retry(removal)})}/>),
  };
}

export const FactRemovalsContext = createContext<ReturnType<typeof useFactRemovals> | null>(null);
