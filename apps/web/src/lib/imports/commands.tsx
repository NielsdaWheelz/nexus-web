"use client";

/** one imports visit owns its commands, independently of list rows and inspector mounts.
 * retries retain the original upload bytes, generation and confirmation. acceptance or an
 * authoritative upload filing refusal resolves uncertainty; reads and remounts never send. */
import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { outcomeUnknown } from "@/lib/api/client";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { requirePaneRuntime, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { resolvePaneRouteModel } from "@/lib/panes/paneRouteModel";
import { readAcquisitionGuard } from "@/lib/libraries/api";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { UploadSessionError, type ImportItem } from "./api";
import { retryUploadRefusal, UPLOAD_COMMAND_FACT } from "./copy";
import { createUploadAttempt, removeUploadSession, reviewUploadAttempt, uploadIngestFile, type UploadAttempt } from "./ingest";

type Subject = { readonly sessionId: string; readonly title: string };
type Command = Subject & (
  | { readonly kind: "RetryUpload"; readonly file: File; readonly upload: UploadAttempt }
  | { readonly kind: "RemoveUpload" | "DiscardCapture" }
);
type Pending = { readonly command: Command; readonly unknown: number; readonly sending: boolean };
interface ImportCommands {
  retryUpload(item: ImportItem): void;
  removeUpload(item: ImportItem): void;
  discardCapture(sessionId: string): void;
}
const Context = createContext<ImportCommands | null>(null);
const keyOf = (command: Command) => `${command.sessionId}:${command.kind === "RetryUpload" ? "RetryUpload" : "RemoveUpload"}`;
const subjectOf = (item: ImportItem): Subject => ({ sessionId: item.ref.slice("upload:".length), title: item.title });

export function ImportCommandsProvider({ commands, children }: { commands: ImportCommands; children: ReactNode }) {
  return <Context value={commands}>{children}</Context>;
}
export function useImportCommands(): ImportCommands {
  const value = useContext(Context);
  if (value === null) throw new Error("imports command owner is missing");
  return value;
}

export function useImportCommandOwner() {
  const pane = requirePaneRuntime(usePaneRuntime(), "ImportCommandOwner");
  const { ctx, run } = useActionRuntime();
  const outcome = useOutcome();
  const resendFeedback = useResendFeedback();
  const draft = useResourceDraft<readonly Pending[]>("Imports.Commands", () => [], value => ({
    changed: false, unconfirmed: value.some(entry => entry.sending || entry.unknown > 0), stopsBrowserWork: false,
  }));
  const { read, set } = draft;
  const live = useRef(false);
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef<Subject | null>(null);
  const choose = useCallback((subject: Subject) => {
    selection.current = subject;
    input.current?.click();
  }, []);
  const send = useCallback((requested: Command): void => {
    if (!live.current || !ctx.isActive()) return;
    const current = ctx.workspace().state.panes.find(item => item.id === pane.paneId)?.current_visit;
    if (current?.id !== pane.visitId || resolvePaneRouteModel(current.href).id !== "imports") return;
    const key = keyOf(requested);
    const retained = read().find(entry => keyOf(entry.command) === key);
    const command = retained?.command ?? requested;
    if (read().some(entry => entry.command.sessionId === command.sessionId && entry.sending)) return;
    const id = command.kind === "RetryUpload" ? "RetryUpload" : "RemoveUpload";
    const fact = command.kind === "DiscardCapture" ? "couldn’t discard this capture." : UPLOAD_COMMAND_FACT[command.kind];
    const retry = { label: "retry", commandKey: key, run: () => send(command) };
    run({ ref: `upload:${command.sessionId}`, id, label: id === "RetryUpload" ? "retry upload" : "remove upload",
      feedbackLabel: id === "RetryUpload" ? "retry upload" : "remove upload",
      title: command.title, confirmation: null, tracked: true, execute: async () => {
        const prior = read().find(entry => keyOf(entry.command) === key);
        set(entries => [...entries.filter(entry => keyOf(entry.command) !== key), { command, unknown: prior?.unknown ?? 0, sending: true }]);
        const clear = () => set(entries => entries.filter(entry => entry.command !== command));
        try {
          if (command.kind === "RetryUpload") {
            let guard = command.upload.review_required ? null : command.upload.guard;
            if (guard === null) {
              try { guard = await readAcquisitionGuard([], ctx.sessionSignal()); }
              catch (error) {
                if (!prior?.unknown && !command.upload.review_required) clear();
                outcome.fail(error, fact, retry);
                return;
              }
            }
            reviewUploadAttempt(command.upload);
            await uploadIngestFile({ file: command.file, attempt: command.upload, guard, signal: ctx.sessionSignal() });
          }
          else await removeUploadSession(command.sessionId);
          clear();
        } catch (error) {
          if (!ctx.isActive()) return;
          if (outcomeUnknown(error) || error instanceof UploadSessionError && command.kind === "RetryUpload"
            && command.upload.confirmation_unsettled) {
            set(entries => entries.map(entry => entry.command === command ? { ...entry, unknown: entry.unknown + 1 } : entry));
          } else {
            const review = command.kind === "RetryUpload" && command.upload.review_required;
            if (review) set(entries => entries.map(entry => entry.command === command ? { ...entry, unknown: 0 } : entry));
            else if (!prior?.unknown || error instanceof UploadSessionError && (error.outcome.kind === "Superseded"
              || error.outcome.kind === "Expired" || error.outcome.kind === "VerificationRejected")) clear();
            if (error instanceof UploadSessionError && command.kind === "RetryUpload") {
              const refusal = retryUploadRefusal(error);
              if (refusal !== null) outcome.say(refusal.line, refusal.retry ? [{ ...retry, run: () => prior?.unknown || review ? send(command) : choose(command) }] : undefined);
            } else outcome.fail(error, fact, command.kind === "RetryUpload" && !prior?.unknown && !review
              ? { ...retry, run: () => choose(command) } : retry);
          }
        } finally {
          set(entries => entries.map(entry => entry.command === command ? { ...entry, sending: false } : entry));
        }
      },
    });
  }, [ctx, run, pane.paneId, pane.visitId, read, set, outcome, choose]);
  const commands = useMemo<ImportCommands>(() => ({
    retryUpload(item) {
      const subject = subjectOf(item);
      const held = read().find(entry => entry.command.sessionId === subject.sessionId && entry.command.kind === "RetryUpload");
      if (held) send(held.command); else choose(subject);
    },
    removeUpload: item => send({ ...subjectOf(item), kind: "RemoveUpload" }),
    discardCapture: sessionId => send({ sessionId, title: "capture", kind: "DiscardCapture" }),
  }), [choose, read, send]);
  const feedback = <>
    <input ref={input} className="sr-only" type="file" tabIndex={-1} aria-label="choose the file again to continue"
      accept=".pdf,.epub,application/pdf,application/epub+zip" onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = "";
        const subject = selection.current;
        selection.current = null;
        if (file !== undefined && subject !== null) send({ ...subject, kind: "RetryUpload", file, upload: createUploadAttempt(subject.sessionId) });
      }} />
    {draft.value.filter(entry => entry.unknown > 0).map(entry => <Hold key={keyOf(entry.command)}
      id={`${draft.owner}:${keyOf(entry.command)}`} attempt={entry.unknown - 1}
      {...resendFeedback({ line: {
        fact: entry.command.kind === "RetryUpload" ? "not sure the upload finished."
          : entry.command.kind === "RemoveUpload" ? "not sure this import was removed." : "not sure the capture was discarded.",
        reason: UNKNOWN_OUTCOME_REASON,
      }, resend: { label: "retry", commandKey: keyOf(entry.command), run: () => send(entry.command), busy: entry.sending } })} />)}
  </>;
  return { commands, feedback };
}
