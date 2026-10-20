"use client";

// Unsent text and model choice live only in memory, per account, pane and chat.
// Pane retirement forgets its drafts; acceptance spends only the submitted text.
import { useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { useLatestWorkspace, useSubscribeWorkspace } from "@/lib/workspace/store";
import { useWorkGuard } from "@/lib/unsavedWork";
import { bindChatWorkGuard, retireChatPane, setChatCommandAccount, suspendChatCommands } from "./commands";
import type { Selection } from "./wire";

export type Draft = Readonly<{ text: string; selection: Selection | null }>;
const EMPTY: Draft = { text: "", selection: null };
export const chatDraftOwnerId = (accountId: string, viewId: string, scope: string) =>
  JSON.stringify(["chat-draft", accountId, viewId, scope]);
const drafts = new Map<string, {
  accountId: string; viewId: string; value: Draft;
  listeners: Set<() => void>; release: (() => void) | null;
}>();

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
      const panes = new Set(workspace().state.panes.map(pane => pane.id));
      for (const [key, entry] of drafts) {
        if (entry.accountId === accountId && panes.has(entry.viewId)) continue;
        entry.release?.(); drafts.delete(key);
        retireChatPane(entry.accountId, entry.viewId);
      }
    };
    retire();
    const unsubscribe = subscribe(retire);
    return () => {
      unsubscribe(); unbind(); suspendChatCommands(accountId);
      for (const [key, entry] of drafts) if (entry.accountId === accountId) {
        entry.release?.(); drafts.delete(key);
      }
    };
  }, [accountId, guard, workspace, subscribe]);
}

export function useChatDraft(scope: string, viewId: string) {
  const { accountId } = useAuthenticatedAccount();
  const guard = useWorkGuard();
  const key = chatDraftOwnerId(accountId, viewId, scope);
  const entry = useMemo(() => {
    // Server rendering never shares authored account data.
    const existing = typeof window === "undefined" ? null : drafts.get(key);
    if (existing) return existing;
    const created = { accountId, viewId, value: EMPTY, listeners: new Set<() => void>(), release: null as (() => void) | null };
    if (typeof window !== "undefined") drafts.set(key, created);
    return created;
  }, [accountId, viewId, key]);
  const subscribe = useMemo(() => (listener: () => void) => {
    entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  }, [entry]);
  useLayoutEffect(() => {
    drafts.set(key, entry);
    entry.release?.();
    entry.release = guard.register({ id: key, scope: { kind: "pane", paneId: viewId },
      read: () => ({ changed: entry.value.text !== "", unconfirmed: false, stopsBrowserWork: false }), subscribe });
    // A retained pane, not this particular composer mount, owns registration.
  }, [entry, guard, key, viewId, subscribe]);
  const draft = useSyncExternalStore(subscribe, () => entry.value, () => EMPTY);
  const commands = useMemo(() => {
    const write = (value: Draft) => { entry.value = value; for (const listener of entry.listeners) listener(); };
    return {
      setText: (text: string) => write({ ...entry.value, text }),
      setSelection: (selection: Selection | null) => write({ ...entry.value, selection }),
      seed: (text: string) => write({ ...entry.value, text }),
      spend: (submitted: string) => write({ text: entry.value.text === submitted ? "" : entry.value.text, selection: null }),
    };
  }, [entry]);
  return { draft, owner: key, ...commands };
}
