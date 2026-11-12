"use client";

// A retained pane owns its editable input and accepted-send read obligation. Composer
// mounts observe it; receipt promotion never writes another chat's command owner.
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";
import { useWorkGuard, type WorkGuard } from "@/lib/unsavedWork";
import { bindChatWorkGuard, revokeChatPreparation, setChatCommandAccount, suspendChatCommands } from "./commands";
import type { ReaderQuote } from "./readerIntent";
import type { SelectionEditor } from "./selection";
import type { AcceptedReceipt, Refusal } from "./wire";

export type Draft = Readonly<{ text: string; selection: SelectionEditor; quote: ReaderQuote | null }>;
export type DraftCaret = Readonly<{ start: number; end: number; direction: "forward" | "backward" | "none" }>;
export type AcceptedDraft = Readonly<{ receipt: AcceptedReceipt; visitId: string }>;
type Snapshot = Readonly<{ draft: Draft; accepted: AcceptedDraft | null; refusal: Refusal | null }>;
const EMPTY: Draft = { text: "", selection: { kind: "Uninitialized" }, quote: null };
const EMPTY_SNAPSHOT: Snapshot = { draft: EMPTY, accepted: null, refusal: null };
export const chatDraftOwnerId = (accountId: string, viewId: string) =>
  JSON.stringify(["librarian-draft", accountId, viewId]);
const drafts = new Map<string, ChatDraftOwner>();

function createDraft(accountId: string, viewId: string, guard: WorkGuard) {
  let value = EMPTY_SNAPSHOT;
  let caret: DraftCaret | null = null;
  let release: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const write = (draft: Draft) => {
    const previous = value.draft.quote;
    value = { ...value, draft, refusal: null };
    if (previous && previous.id !== draft.quote?.id) revokeChatPreparation(accountId, viewId);
    emit();
  };
  const register = () => {
    release?.();
    if (typeof window === "undefined") return;
    release = guard.register({ id: chatDraftOwnerId(accountId, viewId), scope: { kind: "pane", paneId: viewId },
      read: () => ({ changed: value.draft.text !== "" || value.draft.quote !== null, unconfirmed: false, stopsBrowserWork: false }),
      readCopyText: () => value.draft.text, subscribe: owner.subscribe });
  };
  const owner = {
    accountId, viewId,
    getSnapshot: () => value,
    getCaret: () => caret,
    setCaret: (next: DraftCaret) => { caret = next; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setDraft: write,
    setText: (text: string) => write({ ...value.draft, text }),
    setSelection: (selection: SelectionEditor) => { if (selection !== value.draft.selection) write({ ...value.draft, selection }); },
    setQuote: (quote: ReaderQuote | null) => write({ ...value.draft, quote }),
    seed: (text: string) => write({ ...value.draft, text, quote: null }),
    refuse: (refusal: Refusal | null) => { value = { ...value, refusal }; emit(); },
    spend(submitted: Draft) {
      if (value.draft !== submitted) return false;
      caret = null; write(EMPTY); return true;
    },
    accept(receipt: AcceptedReceipt, submitted: Draft | null, currentVisit: boolean, visitId: string) {
      // Record the monotonic fact before promotion or observer callbacks can fail.
      value = { ...value, accepted: currentVisit ? { receipt, visitId } : null, refusal: null };
      if (submitted !== null && value.draft === submitted) { value = { ...value, draft: EMPTY }; caret = null; }
      emit();
    },
    accountFor(accepted: AcceptedDraft | null) {
      // The reader captured this token before starting its request. An older read
      // cannot account for acceptance that arrived while it was in flight.
      if (accepted !== null && value.accepted === accepted) { value = { ...value, accepted: null }; emit(); }
    },
    retireAcceptance() { if (value.accepted !== null) { value = { ...value, accepted: null }; emit(); } },
    retain() { drafts.set(chatDraftOwnerId(accountId, viewId), owner); register(); },
    revokePreparation() { revokeChatPreparation(accountId, viewId); },
    dispose() { owner.revokePreparation(); release?.(); release = null; listeners.clear(); },
  };
  register();
  return owner;
}
export type ChatDraftOwner = ReturnType<typeof createDraft>;

/** Acquisition also installs loss protection; it is safe before the destination mounts. */
export function getChatDraft(accountId: string, viewId: string, guard: WorkGuard): ChatDraftOwner {
  const key = chatDraftOwnerId(accountId, viewId);
  if (typeof window === "undefined") return createDraft(accountId, viewId, guard);
  const existing = drafts.get(key);
  if (existing) return existing;
  const owner = createDraft(accountId, viewId, guard);
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
          if (new URL(visit.href, "https://nexus.invalid").pathname !== "/librarian") entry.revokePreparation();
          if (accepted && (visit.id !== accepted.visitId || new URL(visit.href, "https://nexus.invalid").pathname !== "/librarian")) entry.retireAcceptance();
          continue;
        }
        entry.dispose(); drafts.delete(key);
      }
    };
    retire();
    const unsubscribe = subscribe(retire);
    return () => {
      unsubscribe(); unbind(); suspendChatCommands(accountId);
      for (const [key, entry] of drafts) if (entry.accountId === accountId) { entry.dispose(); drafts.delete(key); }
    };
  }, [accountId, guard, workspace, subscribe]);
}

export function useChatDraft(viewId: string) {
  const { accountId } = useAuthenticatedAccount();
  const guard = useWorkGuard();
  const entry = useMemo(() => getChatDraft(accountId, viewId, guard), [accountId, viewId, guard]);
  useLayoutEffect(() => { entry.retain(); }, [entry]);
  const snapshot = useSyncExternalStore(entry.subscribe, entry.getSnapshot, () => EMPTY_SNAPSHOT);
  return { ...entry, ...snapshot, owner: chatDraftOwnerId(accountId, viewId), entry };
}
