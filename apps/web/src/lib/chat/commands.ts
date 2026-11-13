"use client";

import type { Outcome } from "@/components/feedback/Feedback";
import type { Line, Verb } from "@/components/feedback/stage";
import { publishChange } from "@/lib/api/changes";
import { apiFetch, requestWithDeadline, type ApiError } from "@/lib/api/client";
import { exactWrite, requestWithRetry } from "@/lib/api/retry";
import type { ApiJson } from "@/lib/api/wire";
import { getWritingRuntime } from "@/lib/notes/runtime";
import type { WorkGuard } from "@/lib/unsavedWork";
import { failureOf, rejected, refusal, type AcceptedReceipt, type Refusal, type RejectionCode, type RunCreateRequest, type Selection } from "./wire";

export type DraftRequest = Omit<RunCreateRequest, "expected_deletion_revision">;
export type CommandDefect = Readonly<{ error: unknown; occurrence: number }>;
export type ChatCommand =
  | { readonly kind: "Send"; readonly request: DraftRequest; readonly runId: string; readonly viewId: string }
  | { readonly kind: "RetryTurn"; readonly sourceRunId: string; readonly selection: Selection; readonly runId: string; readonly viewId: string }
  | { readonly kind: "DeleteTurn"; readonly runId: string; readonly viewId: string };
export type CommandOutcome =
  | { readonly kind: "Settled" | "Pending" | "Handled" }
  | { readonly kind: "Accepted"; readonly receipt: AcceptedReceipt }
  | { readonly kind: "Failed"; readonly line: Line; readonly error: ApiError | null; readonly rejection: RejectionCode | null };
export type CommandState =
  | { readonly kind: "Idle" }
  | { readonly kind: "Busy" | "Unconfirmed"; readonly command: ChatCommand; readonly phase: "Preparing" | "Sending"; readonly attempt: number; readonly standing: { kind: "Unknown"; refused: Refusal | null } | null };
export type LibrarianCommands = ReturnType<typeof createCommands>;
export const IDLE_COMMAND: CommandState = { kind: "Idle" };
export const failed = (answer: Refusal, rejection: RejectionCode | null = null): CommandOutcome => ({ kind: "Failed", ...answer, rejection });
export const refusalOf = ({ line, error }: Extract<CommandOutcome, { kind: "Failed" }>): Refusal => ({ line, error });
export function sayRefusal({ say, fail }: Outcome, outcome: CommandOutcome, retry?: Verb): void {
  if (outcome.kind !== "Failed") return;
  if (outcome.error === null) say(outcome.line);
  else fail(outcome.error, outcome.line.fact, retry);
}
export const commandKey = (command: ChatCommand) => `${command.kind}:${command.runId}`;
export const unsureFact = (command: ChatCommand) => command.kind === "DeleteTurn" ? "not sure the turn was deleted." : "not sure your question sent.";
export const refusedFact = (command: Pick<ChatCommand, "kind">) => command.kind === "DeleteTurn" ? "couldn’t delete this turn." : "question not sent.";
export const pendingReason = (state: CommandState) => state.kind === "Idle" ? null : state.standing ? unsureFact(state.command) : state.phase === "Preparing" ? "preparing this question." : state.command.kind === "DeleteTurn" ? "deleting this turn." : "sending this question.";

let currentAccount: string | null = null;
let entry: { accountId: string; commands: LibrarianCommands; release: (() => void) | null } | null = null;
let guard: WorkGuard | null = null;
function register() {
  if (entry === null) return;
  entry.release?.();
  const owner = entry.commands;
  entry.release = guard?.register({ id: `librarian-command:${entry.accountId}`, scope: { kind: "account" },
    read: () => ({ changed: false, unconfirmed: owner.hasUnconfirmed(), stopsBrowserWork: false }), subscribe: owner.subscribe }) ?? null;
}
export function bindChatWorkGuard(value: WorkGuard): () => void {
  guard = value; register();
  return () => { entry?.release?.(); if (entry) entry.release = null; if (guard === value) guard = null; };
}
export function setChatCommandAccount(accountId: string | null) {
  if (currentAccount === accountId) return;
  if (entry?.accountId !== accountId) { entry?.release?.(); entry?.commands.clear(); entry = null; }
  currentAccount = accountId;
}
export function suspendChatCommands(accountId: string) { if (currentAccount === accountId) setChatCommandAccount(null); }
export function getLibrarianCommands(accountId: string): LibrarianCommands {
  if (typeof window === "undefined") return createCommands(accountId);
  if (entry === null || entry.accountId !== accountId) {
    entry?.release?.(); entry?.commands.clear();
    entry = { accountId, commands: createCommands(accountId), release: null }; register();
  }
  return entry.commands;
}
export function revokeChatPreparation(accountId: string, viewId: string) {
  if (entry?.accountId === accountId) entry.commands.revokePreparation(viewId);
}

/** One account's in-flight admission retains its identity, bytes and loss guard.
 * Acceptance releases admission immediately; generation is the server's FIFO. */
function createCommands(accountId: string) {
  let state: CommandState = IDLE_COMMAND;
  let defect: CommandDefect | null = null;
  let occurrence = 0;
  let retired = false;
  let flight: Promise<CommandOutcome> | null = null;
  let pending: { command: ChatCommand; body: string | null; uncertain: boolean; attempt: number; controller: AbortController; prefix: Promise<string>; accepted: ((receipt: AcceptedReceipt) => void) | null } | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const set = (value: CommandState) => { state = value; emit(); };
  const active = () => !retired && (typeof window === "undefined" || currentAccount === accountId);
  const settle = () => { pending = null; };
  const reportDefect = (error: unknown) => {
    defect = { error, occurrence: ++occurrence }; emit();
  };
  async function send(): Promise<CommandOutcome> {
    const attempt = pending;
    if (attempt === null || !active()) return { kind: "Handled" };
    const { command, controller } = attempt;
    let accepted: AcceptedReceipt;
    set({ kind: "Busy", command, phase: attempt.body === null && command.kind !== "DeleteTurn" ? "Preparing" : "Sending", attempt: attempt.attempt, standing: attempt.uncertain ? { kind: "Unknown", refused: null } : null });
    try {
      if (command.kind !== "DeleteTurn" && attempt.body === null) {
        attempt.body = await requestWithDeadline({ signal: controller.signal, timeoutMs: 30_000, request: async signal => {
          const store = await getWritingRuntime(accountId).store;
          await store.whenUploaded(await attempt.prefix, signal);
          const { data } = await requestWithRetry(next => apiFetch<ApiJson<"/me", "get">>("/api/me", { signal: next }), signal);
          return JSON.stringify(command.kind === "Send" ? { ...command.request, expected_deletion_revision: data.chat_deletion_revision }
            : { selection: command.selection, expected_deletion_revision: data.chat_deletion_revision });
        } });
      }
      if (!active() || pending !== attempt) return { kind: "Handled" };
      set({ kind: "Busy", command, phase: "Sending", attempt: attempt.attempt, standing: attempt.uncertain ? { kind: "Unknown", refused: null } : null });
      if (command.kind === "DeleteTurn") {
        await apiFetch(`/api/chat-runs/${command.runId}`, { method: "DELETE", signal: controller.signal });
        settle(); publishChange("Chats"); return { kind: "Settled" };
      }
      const path = command.kind === "Send" ? "/api/chat-runs" : `/api/chat-runs/${command.sourceRunId}/retry` as const;
      const result = await exactWrite(signal => apiFetch<ApiJson<"/chat-runs", "post">>(path, {
        method: "POST", body: attempt.body, headers: { "Idempotency-Key": command.runId }, signal,
      }), controller.signal);
      attempt.uncertain ||= result.uncertain;
      if (result.kind === "Failed") throw result.error;
      if (!active() || pending !== attempt) return { kind: "Handled" };
      const receipt = result.value.data;
      if (receipt.outcome.kind === "Rejected") {
        const code = receipt.outcome.reason.code;
        const answer = rejected(refusedFact(command), code);
        if (attempt.uncertain && code !== "E_CHAT_CREATION_STALE") {
          set({ kind: "Unconfirmed", command, phase: "Sending", attempt: ++attempt.attempt, standing: { kind: "Unknown", refused: answer } });
          return { kind: "Pending" };
        }
        settle(); return failed(answer, code);
      }
      attempt.uncertain = true;
      if (receipt.outcome.turn.run_id !== command.runId) throw new Error("admission answered another run identity");
      accepted = { ...receipt, outcome: receipt.outcome };
      attempt.uncertain = false;
      settle(); publishChange("Chats", "ChatSelection");
    } catch (error) {
      if (!active() || pending !== attempt) return { kind: "Handled" };
      const failure = failureOf(error);
      if (attempt.body === null && command.kind !== "DeleteTurn" && (failure.kind === "Unknown" || failure.kind === "Refused")) {
        settle(); return failed(refusal("couldn’t prepare this question.", failure.error));
      }
      if (failure.kind === "Handled") return { kind: "Handled" };
      if (failure.kind === "Unknown" || attempt.uncertain || command.kind === "DeleteTurn" && failure.kind === "Defect") {
        attempt.uncertain = true;
        set({ kind: "Unconfirmed", command, phase: "Sending", attempt: ++attempt.attempt, standing: { kind: "Unknown", refused: failure.kind === "Refused" ? refusal(refusedFact(command), failure.error) : null } });
        if (failure.kind === "Defect") reportDefect(error);
        return { kind: "Pending" };
      }
      settle();
      if (failure.kind === "Defect") { reportDefect(error); return { kind: "Handled" }; }
      return failed(refusal(refusedFact(command), failure.error));
    }
    attempt.accepted?.(accepted);
    return { kind: "Accepted", receipt: accepted };
  }
  const run = () => flight ?? (flight = send().finally(() => { flight = null; if (pending === null) set(IDLE_COMMAND); }));
  return {
    isActive: active,
    canExecute: () => active() && state.kind === "Idle" && flight === null,
    getSnapshot: () => state,
    getDefect: () => defect,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    hasUnconfirmed: () => pending?.uncertain === true || state.kind === "Busy" && state.phase === "Sending",
    reportDefect,
    clearDefect() { defect = null; emit(); },
    execute(command: ChatCommand, accepted: ((receipt: AcceptedReceipt) => void) | null = null): Promise<CommandOutcome> {
      if (!active()) return Promise.resolve({ kind: "Handled" });
      if (pending !== null || flight !== null) return Promise.resolve({ kind: "Pending" });
      const prefix = command.kind === "DeleteTurn" ? Promise.resolve("0") : getWritingRuntime(accountId).committedPrefix();
      void prefix.catch(() => {});
      pending = { command, body: null, uncertain: false, attempt: 0, controller: new AbortController(), prefix, accepted };
      defect = null;
      return run();
    },
    retry: () => run(),
    revokePreparation(viewId: string) {
      if (state.kind !== "Busy" || state.phase !== "Preparing" || pending?.command.viewId !== viewId) return;
      pending.controller.abort(); settle();
    },
    clear() { retired = true; pending?.controller.abort(); pending = null; state = IDLE_COMMAND; emit(); listeners.clear(); },
  };
}

export async function readTurn(runId: string) {
  return (await apiFetch<ApiJson<"/chat-runs/{run_id}", "get">>(`/api/chat-runs/${runId}`)).data;
}
export async function cancelTurn(runId: string): Promise<void> {
  await apiFetch(`/api/chat-runs/${runId}/cancel`, { method: "POST" });
  publishChange("Chats");
}
