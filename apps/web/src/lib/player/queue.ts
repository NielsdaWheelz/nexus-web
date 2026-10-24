/**
 * A playback queue is an occurrence sequence, never collection membership or progress.
 * Its cursor names an entry; null means exhausted. Only upcoming entries can move.
 * Commands carry the caller's queue identity/revision. Persistence owners refuse stale
 * commands; they never rebase an edit onto a different queue.
 */
import type { Schema } from "@/lib/api/wire";

/** A modeled queue refusal; command callers keep the workspace and show owned feedback. */
export class QueueCommandError extends Error {}

export type QueueEntry = Schema<"QueueEntry">;
export type QueueSource = NonNullable<Schema<"QueueState">["source"]>;
export type QueueState = Schema<"QueueState">;

export interface QueueHeader {
  readonly queue_id: string;
  readonly revision: string;
  readonly current_entry_id: string | null;
  readonly current_entry: QueueEntry | null;
  readonly current_index: number | null;
  readonly count: number;
  readonly can_restore: boolean;
  readonly source: QueueSource | null;
}

export type QueueCommand =
  | { readonly kind: "append" | "insert-next"; readonly entry: QueueEntry }
  | { readonly kind: "move-before"; readonly entry_id: string; readonly before_entry_id: string | null }
  | { readonly kind: "remove"; readonly entry_id: string; readonly failed_current: boolean }
  | { readonly kind: "select"; readonly entry_id: string; readonly play: boolean; readonly position_ms: number | null }
  | { readonly kind: "previous" | "next" | "stop" | "clear" | "restore" };

export interface QueueRequest {
  readonly queue_id: string;
  readonly expected_revision: string;
  readonly command: QueueCommand;
}

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
    current_index: index < 0 ? null : index, count: state.entries.length, can_restore: false, source: state.source };
}

export function emptyQueue(): QueueState {
  return { queue_id: crypto.randomUUID(), entries: [], current_entry_id: null, source: null };
}

export function captureQueue(mediaIds: readonly string[], selected: string, source: QueueSource | null): QueueState {
  if (mediaIds.length > 10_000) throw new QueueCommandError("too many episodes; narrow this view");
  const entries = mediaIds.map(media_id => ({ id: crypto.randomUUID(), media_id }));
  const current = entries.find(entry => entry.media_id === selected);
  if (current === undefined) throw new QueueCommandError("no playable episodes in this view");
  return { queue_id: crypto.randomUUID(), entries, current_entry_id: current.id, source };
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
      if (state.entries.length === 10_000) throw new QueueCommandError("too many episodes; narrow this view");
      const entries = [...state.entries];
      entries.splice(command.kind === "append" || current < 0 ? entries.length : current + 1, 0, command.entry);
      return { ...state, entries, current_entry_id: state.current_entry_id ?? command.entry.id };
    }
    case "move-before": {
      const index = state.entries.findIndex(entry => entry.id === command.entry_id);
      const before = command.before_entry_id === null ? state.entries.length : state.entries.findIndex(entry => entry.id === command.before_entry_id);
      if (current < 0 || index < 0 || index <= current || before <= current || before < 0) throw new QueueCommandError("only upcoming episodes can move");
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
      if (current < 0 || index < current || (index === current && !command.failed_current)) throw new QueueCommandError("only upcoming episodes can be removed");
      return { ...state, entries: state.entries.filter(entry => entry.id !== command.entry_id),
        current_entry_id: index === current ? state.entries[index + 1]?.id ?? null : state.current_entry_id };
    }
    case "select":
      if (!state.entries.some(entry => entry.id === command.entry_id)) throw new QueueCommandError("episode is no longer queued");
      return { ...state, current_entry_id: command.entry_id };
    case "next":
      return current < 0 ? state : { ...state, current_entry_id: state.entries[current + 1]?.id ?? null };
    case "previous":
      return { ...state, current_entry_id: current < 0 ? state.entries.at(-1)?.id ?? null : state.entries[Math.max(0, current - 1)]?.id ?? null };
    case "stop": return state;
    case "clear": return emptyQueue();
    case "restore": throw new Error("restore belongs to the saved queue owner");
  }
}
