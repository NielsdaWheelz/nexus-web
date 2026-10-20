"use client";

import { useMemo, useSyncExternalStore } from "react";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { isRecord } from "@/lib/validation";
import type { Selection } from "./wire";

// A per-viewer convenience, per tab and pane: the unsent text of one chat (or "new")
// and the model the viewer picked for its next send; a restored workspace finds its
// panes' drafts again. A send's request and run id belong to the chat's command owner
// (commands.ts), never to storage. `selection` null follows the reply target's run,
// else the catalog seed (composer).

export type Draft = Readonly<{ text: string; selection: Selection | null }>;

const PREFIX = "nx_chat_draft.v7:";
const EMPTY: Draft = { text: "", selection: null };
const listeners = new Map<string, Set<() => void>>();
const decoded = new Map<string, { raw: string | null; draft: Draft }>();

function selectionOf(value: unknown): Selection | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.reasoning !== "string") return undefined;
  const model = value.route === "CodexPersonal" ? value.model : value.route === "ProviderApi" ? value.model_ref : null;
  // justify-type-assertion: checked structurally; the server validates every send.
  return typeof model === "string" ? (value as Selection) : undefined;
}

function decode(raw: string): Draft {
  try {
    const value: unknown = JSON.parse(raw);
    const selection = isRecord(value) ? selectionOf(value.selection) : undefined;
    if (isRecord(value) && typeof value.text === "string" && selection !== undefined)
      return { text: value.text, selection };
  } catch {
    // an unparseable record is discarded like an unreadable one
  }
  return EMPTY;
}

function read(key: string): Draft {
  const raw = window.sessionStorage.getItem(key);
  const cached = decoded.get(key);
  if (cached?.raw === raw) return cached.draft;
  const draft = raw === null ? EMPTY : decode(raw);
  decoded.set(key, { raw, draft });
  return draft;
}

function write(key: string, draft: Draft): void {
  if (!draft.text && !draft.selection) window.sessionStorage.removeItem(key);
  else window.sessionStorage.setItem(key, JSON.stringify(draft));
  for (const listener of listeners.get(key) ?? []) listener();
}

export function useChatDraft(scope: string, viewId: string) {
  const { accountId } = useAuthenticatedAccount();
  const key = `${PREFIX}${accountId}:${viewId}:${scope}`;
  const draft = useSyncExternalStore(
    (listener) => {
      const set = listeners.get(key) ?? new Set();
      listeners.set(key, set.add(listener));
      return () => void set.delete(listener);
    },
    () => read(key),
    () => EMPTY,
  );
  const commands = useMemo(
    () => ({
      /** A claimed reader entry fills its fresh pane's text and model together. */
      setDraft: (draft: Draft) => write(key, draft),
      setText: (text: string) => write(key, { ...read(key), text }),
      setSelection: (selection: Selection | null) => write(key, { ...read(key), selection }),
      /** An explicit launch's text (`?draft=`) fills an empty draft once. */
      seed: (text: string) => {
        if (!read(key).text) write(key, { ...read(key), text });
      },
      /** An accepted send spends its text (unless edited since) and its explicit model. */
      spend: (submitted: string) => {
        const current = read(key);
        write(key, { text: current.text === submitted ? "" : current.text, selection: null });
      },
    }),
    [key],
  );
  return { draft, ...commands };
}
