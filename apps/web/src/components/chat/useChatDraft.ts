"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  serializeChatDraftKey,
  type ChatDraftKey,
} from "@/lib/conversations/chatDraftKey";
import {
  chatDraftStoreFor,
  chatDraftStorageKeyForView,
  CHAT_DRAFT_STORAGE_PREFIX,
  EMPTY_DRAFT_RECORD,
  subscribeChatDraftStores,
  type ChatCommandView,
} from "@/lib/conversations/chatDraftStore";

/** React subscribes to the command owner; callbacks never read another draft. */
export function useChatDraft({
  draftKey,
  view,
  conversationId,
  initialContent = "",
}: {
  draftKey: ChatDraftKey;
  view: ChatCommandView;
  conversationId: string | null;
  initialContent?: string;
}) {
  const editableDraftKey =
    CHAT_DRAFT_STORAGE_PREFIX + serializeChatDraftKey(draftKey);
  const { identity, accountId } = view;
  const getStorageKey = useCallback(
    () =>
      chatDraftStorageKeyForView(
        editableDraftKey,
        { identity, accountId },
        conversationId,
      ),
    [editableDraftKey, identity, accountId, conversationId],
  );
  const recoveryStorageKey = useSyncExternalStore(
    subscribeChatDraftStores,
    getStorageKey,
    () => editableDraftKey,
  );
  const recoveryConflict = recoveryStorageKey === null;
  const activeDraftKey = recoveryStorageKey ?? editableDraftKey;
  const store = useMemo(
    () => chatDraftStoreFor(activeDraftKey),
    [activeDraftKey],
  );
  const record = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    () => EMPTY_DRAFT_RECORD,
  );
  // Server markup must stay locked until the browser storage snapshot is adopted.
  const restored = useSyncExternalStore(
    store.subscribe,
    () => true,
    () => false,
  );
  const seeded = useRef<{ store: typeof store; content: string } | null>(null);
  useEffect(() => {
    if (
      seeded.current?.store === store &&
      seeded.current.content === initialContent
    )
      return;
    const previous = seeded.current;
    seeded.current = { store, content: initialContent };
    if (previous?.store !== store) {
      if (initialContent !== "") store.seedContent(initialContent);
    } else if (previous.content !== initialContent) {
      // A deliberate new launch in this mounted view replaces an editable draft.
      store.setContent(initialContent);
    }
  }, [initialContent, store]);
  return {
    content: record.text,
    setContent: store.setContent,
    selection: record.selection,
    setSelection: store.setSelection,
    restored,
    activeDraftKey,
    editableDraftKey,
    recoveryConflict,
    recoveredFromAnotherDraft: activeDraftKey !== editableDraftKey,
    operation: record.operation,
    reconciling: record.operation.kind === "ReconcileRequired",
    beginSubmit: store.beginSubmit,
    retrySubmit: store.retrySubmit,
    store,
  };
}
