/**
 * A playback queue is an occurrence sequence, never collection membership or progress.
 * Its cursor names an entry; null means exhausted. Only upcoming entries can move.
 * Commands carry the caller's queue identity/revision. Persistence owners refuse stale
 * commands; they never rebase an edit onto a different queue.
 */
import type { Line } from "@/components/feedback/stage";
import type { ApiError } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";

/** Why a queue or playback-ownership press did nothing. */
export type QueueRefusal =
  | "Loading" | "LoadFailed" | "Saving" | "Changed" | "Refused" | "Unsettled" | "AddUnsettled" | "NoRestore"
  | "NotQueued" | "NotInView" | "TooMany" | "OwnerSilent" | "Moving" | "NotMoved" | "Unsupported" | "NotConnected"
  | "Superseded";

/** What a refusal tells its reader. null: nothing to tell. `Superseded`: a newer press owns the
 * outcome. `Unsettled`: the held line for the unconfirmed change already stands. */
const REFUSAL_LINES: Readonly<Record<QueueRefusal, Line | null>> = {
  Loading: { fact: "the queue is still loading." },
  LoadFailed: { fact: "couldn’t load the queue." },
  Saving: { fact: "the queue is still saving." },
  Changed: { fact: "couldn’t change the queue.", reason: "it changed meanwhile." },
  Refused: { fact: "couldn’t change the queue." },
  Unsettled: null,
  AddUnsettled: { fact: "couldn’t add to the queue.", reason: "another queue change isn’t settled." },
  NoRestore: { fact: "the previous queue can’t be restored anymore." },
  NotQueued: { fact: "that episode is no longer queued." },
  NotInView: { fact: "that episode is no longer in this view." },
  TooMany: { fact: "too many episodes to queue." },
  OwnerSilent: { fact: "another nexus tab has the player and isn’t answering." },
  Moving: { fact: "playback is moving to another tab." },
  NotMoved: { fact: "couldn’t move playback to this tab." },
  Unsupported: { fact: "this browser can’t run the player." },
  NotConnected: { fact: "couldn’t change the queue.", reason: "the player isn’t connected." },
  Superseded: null,
};

/** A modeled queue refusal. Its `line` is the whole of what its reader is told. */
export class QueueCommandError extends Error {
  readonly line: Line | null;
  constructor(readonly refusal: QueueRefusal) {
    const line = REFUSAL_LINES[refusal];
    super(line === null ? "" : line.reason ? `${line.fact} ${line.reason}` : line.fact);
    this.line = line;
  }
}

export type QueueEntry = Schema<"QueueEntry">;
export type QueueState = Schema<"QueueState">;

export interface QueueManifest {
  readonly queue_id: string;
  readonly revision: string;
  readonly entries: readonly QueueEntry[];
}

export type QueueIndex =
  | { readonly kind: "Ready"; readonly snapshot: QueueManifest }
  | { readonly kind: "Loading"; readonly previous: QueueManifest | null }
  | { readonly kind: "Failed"; readonly previous: QueueManifest | null; readonly error: ApiError | QueueCommandError };

export interface QueueHeader {
  readonly queue_id: string;
  readonly revision: string;
  readonly current_entry_id: string | null;
  readonly current_entry: QueueEntry | null;
  readonly current_index: number | null;
  readonly count: number;
  readonly can_restore: boolean;
}

export type QueueCommand =
  | { readonly kind: "append" | "insert-next"; readonly entry: QueueEntry }
  | { readonly kind: "move-before"; readonly entry_id: string; readonly before_entry_id: string | null }
  | { readonly kind: "remove"; readonly entry_id: string; readonly failed_current: boolean }
  | { readonly kind: "select"; readonly entry_id: string; readonly play: boolean; readonly position_ms: number | null }
  | { readonly kind: "previous" | "next" | "stop" | "restore" };

export interface QueueRequest {
  readonly queue_id: string;
  readonly expected_revision: string;
  readonly command: QueueCommand;
}

export type QueueFence = Pick<QueueRequest, "queue_id" | "expected_revision">;

/** The native service alone owns its cursor, including while the webview is absent.
 * `known` distinguishes its initial placeholder from an accepted null snapshot. */
export interface NativeQueueOwner {
  known(): boolean;
  uncertain(): boolean;
  read(): Promise<QueueHeader | null>;
  page(input: { readonly expected_revision: string; readonly offset: number; readonly limit: number }): Promise<QueueEntry[]>;
  replace(input: { readonly state: QueueState; readonly expected_revision: string | null; readonly known_descriptor: Schema<"PlayerDescriptor"> | null; readonly is_current: () => boolean }): Promise<QueueHeader>;
  command(input: QueueRequest): Promise<QueueHeader>;
}

export function currentQueueEntry(state: QueueState): QueueEntry | null {
  return state.entries.find(entry => entry.id === state.current_entry_id) ?? null;
}

export function queueHeader(state: QueueState, revision: string): QueueHeader {
  const index = state.entries.findIndex(entry => entry.id === state.current_entry_id);
  return { queue_id: state.queue_id, revision, current_entry_id: state.current_entry_id, current_entry: currentQueueEntry(state),
    current_index: index < 0 ? null : index, count: state.entries.length, can_restore: false };
}

export function captureQueue(mediaIds: readonly string[], selected: string): QueueState {
  if (mediaIds.length > 10_000) throw new QueueCommandError("TooMany");
  const entries = mediaIds.map(media_id => ({ id: crypto.randomUUID(), media_id }));
  const current = entries.find(entry => entry.media_id === selected);
  if (current === undefined) throw new QueueCommandError("NotInView");
  return { queue_id: crypto.randomUUID(), entries, current_entry_id: current.id };
}

/** Pure sequence edits. Restart timing and playback intent belong to the command owner. */
export function editQueue(state: QueueState, command: QueueCommand): QueueState {
  const current = state.entries.findIndex(entry => entry.id === state.current_entry_id);
  switch (command.kind) {
    case "append":
    case "insert-next": {
      const existing = state.entries.find(entry => entry.id === command.entry.id);
      if (existing !== undefined) {
        if (existing.media_id !== command.entry.media_id) throw new Error("queue occurrence changed media");
        return state;
      }
      if (state.entries.length === 10_000) throw new QueueCommandError("TooMany");
      const entries = [...state.entries];
      entries.splice(command.kind === "append" || current < 0 ? entries.length : current + 1, 0, command.entry);
      return { ...state, entries, current_entry_id: state.current_entry_id ?? command.entry.id };
    }
    case "move-before": {
      const index = state.entries.findIndex(entry => entry.id === command.entry_id);
      const before = command.before_entry_id === null ? state.entries.length : state.entries.findIndex(entry => entry.id === command.before_entry_id);
      if (current < 0 || index < 0 || index <= current || before <= current || before < 0) throw new QueueCommandError("Changed");
      if (index === before) return state;
      const entry = state.entries[index];
      const entries = state.entries.filter(item => item.id !== entry.id);
      const destination = command.before_entry_id === null ? entries.length : entries.findIndex(item => item.id === command.before_entry_id);
      entries.splice(destination, 0, entry);
      return { ...state, entries };
    }
    case "remove": {
      const index = state.entries.findIndex(entry => entry.id === command.entry_id);
      if (index < 0) return state;
      if (current < 0 || index < current || (index === current && !command.failed_current)) throw new QueueCommandError("Changed");
      return { ...state, entries: state.entries.filter(entry => entry.id !== command.entry_id),
        current_entry_id: index === current ? state.entries[index + 1]?.id ?? null : state.current_entry_id };
    }
    case "select":
      if (!state.entries.some(entry => entry.id === command.entry_id)) throw new QueueCommandError("NotQueued");
      return state.current_entry_id === command.entry_id ? state : { ...state, current_entry_id: command.entry_id };
    case "next":
      return current < 0 ? state : { ...state, current_entry_id: state.entries[current + 1]?.id ?? null };
    case "previous":
      return { ...state, current_entry_id: current < 0 ? state.entries.at(-1)?.id ?? null : state.entries[Math.max(0, current - 1)]?.id ?? null };
    case "stop": return state;
    case "restore": throw new Error("restore belongs to the saved queue owner");
  }
}
