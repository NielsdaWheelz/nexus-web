"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useConnectionAttachments } from "@/components/connections/useConnectionAttachments";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import ResourceList from "@/components/ui/ResourceList";
import ResourceComposer from "@/components/resources/ResourceComposer";
import ResourceIndexRow from "@/components/resources/ResourceIndexRow";
import Button from "@/components/ui/Button";
import { FeedbackNotice, FeedbackStatus } from "@/components/feedback/Feedback";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useChangeStamp } from "@/lib/api/changes";
import { apiFetch, isApiError, outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { connectionMutationErrorMessage, mutateConnection, subscribeLinkMutations } from "@/lib/resourceGraph/links";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./ChatContext.module.css";

const VISIT = definePaneVisitDataKey<Visit<Schema<"ContextOut">>>("Chat.Context");

/** Future prompt membership is an index; removal uses the supplied aggregate version. */
export default function ChatContext({ conversationId, refreshKey }: { conversationId: string; refreshKey: number }) {
  const selfRef = `conversation:${conversationId}`;
  const attachments = useConnectionAttachments(selfRef);
  const [revision, setRevision] = useState(0);
  const changed = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => subscribeLinkMutations(changed), [changed]);
  const [adding, setAdding] = useState(false);
  const metadata = useChangeStamp("Notes", "NoteBodies", "Metadata");
  const context = useServerValue<Schema<"ContextOut">>({
    key: `/conversations/${conversationId}/context`, stale: `${refreshKey}:${revision}:${metadata}`, visit: VISIT,
    load: async (signal) => (await apiFetch<ApiJson<"/conversations/{conversation_id}/context", "get">>(`/api/conversations/${conversationId}/context`, { signal })).data,
  });
  const failure = context.status === "failed" ? context.error : context.status === "ready" ? context.error : null;
  return <section aria-label="Chat context" {...attachments.dropProps}>
    <div className={styles.tools}><ContextualActionMenu resourceRef={assumeCanonicalResourceRef(selfRef)} title="chat context" subjectKey={`context:${selfRef}`} label="more actions for chat context" sections={[{ id: "Pane", actions: [{ kind: "command", id: "Context.Add", label: "add to future context", onSelect: () => setAdding(true) }] }]} />{attachments.control}</div>
    {attachments.attaching ? <FeedbackStatus content={{ tone: "Neutral", title: "uploading and linking…" }} announcement="Polite" /> : null}
    <p className={styles.metadata}>available to future replies</p>
    {context.status === "loading" ? <FeedbackStatus content={{ tone: "Neutral", title: "loading context…" }} announcement="Polite" /> : null}
    {failure ? <FeedbackNotice content={{ tone: "Warning", title: context.status === "ready" ? "couldn’t refresh connections" : "context couldn’t be loaded", requestId: failure.requestId }} announcement="Assertive" actions={[{ label: context.status === "ready" ? "retry refresh" : "retry", onClick: context.refetch, busy: context.status === "failed" ? context.retrying : context.status === "ready" && context.refreshing }]} /> : null}
    {context.status === "ready" ? <ResourceList ariaLabel="Chat context">
      {context.data.items.map((entry) => <ContextIndexItem key={entry.item.ref} entry={entry} conversationId={conversationId} onChanged={context.refetch} />)}
      {context.data.items.length === 0 ? <li><FeedbackStatus content={{ tone: "Neutral", title: "no context yet" }} announcement="None"  /></li> : null}
    </ResourceList> : null}
    {adding ? <ResourceComposer source={{ kind: "resource", ref: selfRef }} occurrenceKey={`context:${selfRef}`} label="add to future context" onSaved={context.refetch} /> : null}
  </section>;
}

function ContextIndexItem({ entry, conversationId, onChanged }: {
  entry: Schema<"ContextOut">["items"][number]; conversationId: string; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof connectionMutationErrorMessage> | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [stale, setStale] = useState(false);
  const submitted = useRef<typeof entry.mutation>(null);
  const refreshRequested = useRef(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  if (defect) throw defect.error;
  const remove = async () => {
    if (busy || stale) return;
    const command = submitted.current ?? entry.mutation;
    if (!command) return;
    submitted.current = command;
    setBusy(true); setFailure(null);
    try {
      await mutateConnection(command);
      submitted.current = null;
      const button = removeButton.current;
      if (button && document.activeElement === button) {
        const row = button.closest("li");
        (row?.nextElementSibling?.querySelector<HTMLElement>("[data-row-focusable]") ?? row?.previousElementSibling?.querySelector<HTMLElement>("[data-row-focusable]"))?.focus();
      }
      onChanged();
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      try {
        const content = connectionMutationErrorMessage(error);
        setFailure(isApiError(error) && error.code === "E_CONTEXT_CHANGED" ? { ...content, title: "future context changed; refresh before removing this item" } : content);
      }
      catch (error) { setDefect({ error }); }
      if (!outcomeUnknown(error)) {
        submitted.current = null;
        refreshRequested.current = false;
        setStale(true);
      }
    } finally { setBusy(false); }
  };
  // A refresh can show a later reattachment while this command's answer is unknown.
  // Only an explicit read after definitive refusal admits a new removal intent.
  useEffect(() => {
    if (!stale || !refreshRequested.current) return;
    refreshRequested.current = false;
    setStale(false);
    setFailure(null);
  }, [entry.mutation, stale]);
  return <ResourceIndexRow item={entry.item} occurrenceKey={`${conversationId}/${entry.item.ref}`}
    primaryControl={entry.mutation ? <Button variant="ghost" size="sm" className={styles.remove} ref={removeButton} aria-disabled={busy || stale}
      aria-label={`remove from future context: ${entry.item.label}`} onClick={() => { void remove(); }}>remove</Button> : undefined}
    nestedContent={failure ? <FeedbackNotice content={failure} announcement="Polite"
      actions={[{ label: stale ? "refresh context" : "retry removal", onClick: stale ? () => { refreshRequested.current = true; onChanged(); } : () => { void remove(); }, busy }]} /> : undefined}
  />;
}
