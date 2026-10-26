"use client";
/** Host capabilities for the same content editor. Reader documents own local
 * drafts and writing only; workspace attachments retain their actual visit and
 * account lifetime. No fake workspace or account authority enters the reader. */
import { createContext, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard, type WorkRisk } from "@/lib/unsavedWork";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";
import { usePaneVisitIdentity, usePaneVisitRetained, usePaneVisitWorkScope } from "@/lib/workspace/paneReturnMemento";
interface Draft<T> { owner: string; value: T; read(): T; set(change: T | ((previous: T) => T)): void; subscribe(listener: () => void): () => void }
export interface NoteEditorHost {
  identity: string;
  retained_input: boolean;
  references: "local" | "all";
  embedded_preview: "literal" | "workspace";
  uploads: { signal(): AbortSignal; is_owned(): boolean; subscribe(listener: () => void): () => void } | null;
  useDraft<T>(name: string, initial: () => T, risk?: (value: T) => WorkRisk, readCopyText?: (value: T) => string | null): Draft<T>;
}
const Context = createContext<NoteEditorHost | null>(null);
/** Rich previews disclose children into the containing outline session. */
export const OutlineEmbeddingOccurrence = createContext<string | null>(null);
export function useOptionalNoteEditorHost(): NoteEditorHost | null { return useContext(Context); }
export function useNoteEditorHost(): NoteEditorHost {
  const host = useContext(Context);
  if (!host) throw new Error("Note editor host is missing");
  return host;
}
/** A workspace draft's optional copy reader shares its existing retained risk owner. */
export function useEditorDraft<T>(name: string, initial: () => T, risk?: (value: T) => WorkRisk, readCopyText?: (value: T) => string | null): Draft<T> {
  const host = useContext(Context);
  const useDraft = host?.useDraft ?? useResourceDraft;
  return useDraft(name, initial, risk, readCopyText);
}
export function WorkspaceNoteEditorHost({ children }: { children: ReactNode }) {
  const identity = usePaneVisitIdentity();
  const retained_input = usePaneVisitRetained();
  const scope = usePaneVisitWorkScope();
  const { ctx } = useActionRuntime();
  const workspace = useLatestWorkspace(), subscribe = useSubscribeWorkspace();
  const host = useMemo<NoteEditorHost>(() => ({
    identity, retained_input, references: "all", embedded_preview: "workspace", useDraft: useResourceDraft,
    uploads: {
      signal: ctx.sessionSignal,
      is_owned: () => workspace().state.panes.some(pane => [pane.current_visit, ...pane.history.back, ...pane.history.forward].some(visit => visit.id === scope.visitId)),
      subscribe,
    },
  }), [identity, retained_input, scope.visitId, ctx.sessionSignal, workspace, subscribe]);
  return <Context value={host}>{children}</Context>;
}
export function ReaderNoteEditorHost({ identity, children }: { identity: string; children: ReactNode }) {
  const host = useMemo<NoteEditorHost>(() => ({ identity, retained_input: false, references: "local", embedded_preview: "literal", uploads: null, useDraft: useReaderDraft }), [identity]);
  return <Context value={host}>{children}</Context>;
}
function useReaderDraft<T>(name: string, initial: () => T, risk?: (value: T) => WorkRisk): Draft<T> {
  const host = useNoteEditorHost(), guard = useWorkGuard();
  const owner = JSON.stringify([host.identity, name]);
  const [opened, setOpened] = useState(() => ({ owner, cell: cell(initial()) }));
  let current = opened.cell;
  if (opened.owner !== owner) { current = cell(initial()); setOpened({ owner, cell: current }); }
  const value = useSyncExternalStore(current.subscribe, current.read, current.read);
  useLayoutEffect(() => risk ? guard.register({ id: owner, scope: { kind: "surface", id: host.identity }, read: () => risk(current.read()), subscribe: current.subscribe }) : undefined, [guard, host.identity, owner, current, risk]);
  return { owner, value, ...current };
}
function cell<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    read: () => value,
    set(change: T | ((previous: T) => T)) {
      // justify-type-assertion: editor drafts are values, never callable records.
      value = typeof change === "function" ? (change as (previous: T) => T)(value) : change;
      for (const listener of listeners) listener();
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
