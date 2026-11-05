"use client";

// A retained pane owns its editable input and accepted-send read obligation. Composer
// mounts observe it; receipt promotion never writes another chat's command owner.
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { reportClientDefect } from "@/lib/telemetry/clientDefects";
import type { CommandDefect } from "./commands";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { bindChatWorkGuard, retireChatPanes, revokeChatPreparation, setChatCommandAccount, suspendChatCommands } from "./commands";
import type { ReaderQuote } from "./readerIntent";
import type { SelectionEditor } from "./selection";
import type { AcceptedReceipt, Refusal } from "./wire";

export type Draft = Readonly<{ text: string; selection: SelectionEditor; quote: ReaderQuote | null }>;
export type DraftCaret = Readonly<{ start: number; end: number; direction: "forward" | "backward" | "none" }>;
export type AcceptedDraft = Readonly<{ receipt: AcceptedReceipt; visitId: string }>;
type Snapshot = Readonly<{ draft: Draft; accepted: AcceptedDraft | null; refusal: Refusal | null; defect: CommandDefect | null }>;
const EMPTY: Draft = { text: "", selection: { kind: "Uninitialized" }, quote: null };
const EMPTY_SNAPSHOT: Snapshot = { draft: EMPTY, accepted: null, refusal: null, defect: null };
export const chatDraftOwnerId = (accountId: string, viewId: string, scope: string) =>
  JSON.stringify(["chat-draft", accountId, viewId, scope]);
const drafts = new Map<string, ChatDraftOwner>();

function createDraft(accountId: string, viewId: string, initialScope: string, guard: WorkGuard) {
  let scope = initialScope;
  let value = EMPTY_SNAPSHOT;
  let caret: DraftCaret | null = null;
  let occurrence = 0;
  let release: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const write = (draft: Draft) => {
    const previous = value.draft.quote;
    value = { ...value, draft, refusal: null };
    if (previous && previous.id !== draft.quote?.id) revokeChatPreparation(accountId, scope, viewId, previous.id);
    emit();
  };
  const register = () => {
    release?.();
    if (typeof window === "undefined") return;
    release = guard.register({ id: chatDraftOwnerId(accountId, viewId, scope), scope: { kind: "pane", paneId: viewId },
      read: () => ({ changed: value.draft.text !== "" || value.draft.quote !== null, unconfirmed: false, stopsBrowserWork: false }),
      readCopyText: () => value.draft.text, subscribe: owner.subscribe });
  };
  const owner = {
    accountId, viewId,
    getScope: () => scope,
    getSnapshot: () => value,
    getCaret: () => caret,
    setCaret: (next: DraftCaret) => { caret = next; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setDraft: write,
    setText: (text: string) => write({ ...value.draft, text }),
    setSelection: (selection: SelectionEditor) => { if (selection !== value.draft.selection) write({ ...value.draft, selection }); },
    setQuote: (quote: ReaderQuote | null) => write({ ...value.draft, quote }),
    markQuoteStale(id: string) {
      if (value.draft.quote?.id === id) write({ ...value.draft, quote: { ...value.draft.quote, stale: true } });
    },
    seed: (text: string) => write({ ...value.draft, text }),
    reportDefect(failure: CommandDefect, visitId: string) {
      value = { ...value, defect: { error: failure.error, occurrence: ++occurrence } };
      reportClientDefect(failure.error, { paneId: viewId, visitId, componentStack: "chat command" });
      emit();
    },
    clearDefect() { value = { ...value, defect: null }; emit(); },
    refuse: (refusal: Refusal | null) => { value = { ...value, refusal }; emit(); },
    spend(submitted: Draft) {
      if (value.draft !== submitted) return false;
      caret = null; write(EMPTY); return true;
    },
    accept(receipt: AcceptedReceipt, submitted: Draft | null, currentVisit: boolean, visitId: string) {
      // Record the monotonic fact before promotion or observer callbacks can fail.
      value = { ...value, accepted: currentVisit ? { receipt, visitId } : null, refusal: null };
      if (submitted !== null && value.draft === submitted) { value = { ...value, draft: EMPTY }; caret = null; }
      if (currentVisit && scope === "new") {
        const nextScope = receipt.outcome.conversation_id;
        const key = chatDraftOwnerId(accountId, viewId, nextScope);
        const other = drafts.get(key);
        if (other && other !== owner) throw new Error("accepted chat draft already has a different owner");
        drafts.delete(chatDraftOwnerId(accountId, viewId, scope));
        scope = nextScope;
        drafts.set(key, owner);
        register();
      }
      emit();
    },
    accountFor(accepted: AcceptedDraft | null) {
      // The reader captured this token before starting its request. An older read
      // cannot account for acceptance that arrived while it was in flight.
      if (accepted !== null && value.accepted === accepted) { value = { ...value, accepted: null }; emit(); }
    },
    retireAcceptance() { if (value.accepted !== null) { value = { ...value, accepted: null }; emit(); } },
    retain() { drafts.set(chatDraftOwnerId(accountId, viewId, scope), owner); register(); },
    revokePreparation() { revokeChatPreparation(accountId, scope, viewId, null); },
    dispose() { owner.revokePreparation(); release?.(); release = null; listeners.clear(); },
  };
  register();
  return owner;
}
export type ChatDraftOwner = ReturnType<typeof createDraft>;
export const findChatDraft = (id: string): ChatDraftOwner | null => drafts.get(id) ?? null;

/** Acquisition also installs loss protection; it is safe before the destination mounts. */
export function getChatDraft(accountId: string, viewId: string, scope: string, guard: WorkGuard): ChatDraftOwner {
  const key = chatDraftOwnerId(accountId, viewId, scope);
  if (typeof window === "undefined") return createDraft(accountId, viewId, scope, guard);
  const existing = drafts.get(key);
  if (existing) return existing;
  const owner = createDraft(accountId, viewId, scope, guard);
  drafts.set(key, owner);
  return owner;
}

/** One shell mount owns account teardown and actual pane retirement. */
export function useChatWorkOwners() {
  const { accountId } = useAuthenticatedAccount();
  const guard = useWorkGuard();
  const workspace = useLatestWorkspace();
  const subscribe = useSubscribeWorkspace();
  useLayoutEffect(() => {
    setChatCommandAccount(accountId);
    const unbind = bindChatWorkGuard(guard);
    const retire = () => {
      const currentPanes = workspace().state.panes;
      const panes = new Set(currentPanes.map(pane => pane.id));
      for (const [key, entry] of drafts) {
        if (entry.accountId === accountId && panes.has(entry.viewId)) {
          const accepted = entry.getSnapshot().accepted;
          const visit = currentPanes.find(pane => pane.id === entry.viewId)!.current_visit;
          if (new URL(visit.href, "https://nexus.invalid").pathname !== `/conversations/${entry.getScope()}`) entry.revokePreparation();
          if (accepted && (visit.id !== accepted.visitId || new URL(visit.href, "https://nexus.invalid").pathname !== `/conversations/${accepted.receipt.outcome.conversation_id}`)) entry.retireAcceptance();
          continue;
        }
        entry.dispose(); drafts.delete(key);
      }
      retireChatPanes(accountId, panes);
    };
    retire();
    const unsubscribe = subscribe(retire);
    return () => {
      unsubscribe(); unbind(); suspendChatCommands(accountId);
      for (const [key, entry] of drafts) if (entry.accountId === accountId) { entry.dispose(); drafts.delete(key); }
    };
  }, [accountId, guard, workspace, subscribe]);
}

export function useChatDraft(scope: string, viewId: string) {
  const { accountId } = useAuthenticatedAccount();
  const guard = useWorkGuard();
  const entry = useMemo(() => getChatDraft(accountId, viewId, scope, guard), [accountId, viewId, scope, guard]);
  useLayoutEffect(() => { entry.retain(); }, [entry]);
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot, () => EMPTY_SNAPSHOT);
  return { ...entry, ...snapshot, owner: chatDraftOwnerId(accountId, viewId, scope), entry };
}
