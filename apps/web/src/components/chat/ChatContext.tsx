"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { podcastActionFacts, type PodcastActionSubject } from "@/lib/actions/inlineActions";
import { usePodcastActionFacts } from "@/lib/podcasts/usePodcastActionFacts";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
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
  const root = useRef<HTMLElement>(null);
  const paneId = usePaneRuntime()?.paneId;
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
  const entries = context.status === "ready" ? context.data.items : [];
  const actionFacts = usePodcastActionFacts({ scope: `Chat.Context:${conversationId}`,
    targets: entries.flatMap(entry => entry.item.ref.startsWith("podcast:") ? [{ kind: "Canonical" as const, podcast_id: entry.item.ref.slice(8) }] : []),
    refresh: `${refreshKey}:${revision}:${metadata}:${context.status === "ready" ? context.generation : ""}`,
  });
  const factsError = actionFacts.status === "loading" ? null : actionFacts.error;
  const failure = context.status === "loading" ? null : context.error;
  const podcastFor = (item: Schema<"ContextOut">["items"][number]["item"]): PodcastActionSubject | undefined => item.ref.startsWith("podcast:") ? {
    target: { kind: "Canonical", podcast_id: item.ref.slice(8) }, title: item.label,
    facts: failure !== null
      ? { kind: "Failed", error: failure, retry: context.refetch, retrying: context.status === "failed" ? context.retrying : context.status === "ready" && context.refreshing }
      : context.status !== "ready" || context.refreshing ? { kind: "Resolving" } : podcastActionFacts(actionFacts, { kind: "Canonical", podcast_id: item.ref.slice(8) }),
  } : undefined;
  return <section ref={root} aria-label="Chat context" {...attachments.dropProps}>
    <div className={styles.tools}><ContextualActionMenu resourceRef={assumeCanonicalResourceRef(selfRef)} title="chat context" subjectKey={`context:${selfRef}`} label="more actions for chat context" sections={[{ id: "Pane", actions: [{ kind: "command", id: "Context.Add", label: "add to future context", onSelect: () => setAdding(true) }] }]} />{attachments.control}</div>
    {attachments.attaching ? <FeedbackStatus content={{ tone: "Neutral", title: "uploading and linking…" }} announcement="Polite" /> : null}
    <p className={styles.metadata}>available to future replies</p>
    {context.status === "loading" ? <FeedbackStatus content={{ tone: "Neutral", title: "loading context…" }} announcement="Polite" /> : null}
    {failure ? <FeedbackNotice content={{ tone: "Warning", title: context.status === "ready" ? "couldn’t refresh connections" : "context couldn’t be loaded", requestId: failure.requestId }} announcement="Assertive" actions={[{ label: context.status === "ready" ? "retry refresh" : "retry", onClick: context.refetch, busy: context.status === "failed" ? context.retrying : context.status === "ready" && context.refreshing }]} /> : null}
    {factsError !== null ? <FeedbackNotice content={{ tone: "Warning", title: "couldn’t check podcast subscriptions", requestId: factsError.requestId }} announcement="Polite"
      actions={[{ label: "retry checking subscription", onClick: actionFacts.refetch, busy: actionFacts.status === "failed" ? actionFacts.retrying : actionFacts.status === "ready" && actionFacts.refreshing }]} /> : null}
    {context.status === "ready" ? <ResourceList ariaLabel="Chat context">
      {entries.map((entry, index) => <ContextIndexItem key={entry.item.ref} entry={entry} podcastSubject={podcastFor(entry.item)}
        afterRemoval={() => entries.slice(index + 1).map(next => root.current?.querySelector<HTMLElement>(`[data-resource-ref="${CSS.escape(next.item.ref)}"] [data-row-focusable]`)).find(element => element !== null && element !== undefined) ?? findPaneLandmarkFocusTarget(paneId)}
        conversationId={conversationId} onChanged={context.refetch} />)}
      {context.data.items.length === 0 ? <li><FeedbackStatus content={{ tone: "Neutral", title: "no context yet" }} announcement="None"  /></li> : null}
    </ResourceList> : null}
    {adding ? <ResourceComposer source={{ kind: "resource", ref: selfRef }} occurrenceKey={`context:${selfRef}`} label="add to future context" onSaved={context.refetch} /> : null}
  </section>;
}

function ContextIndexItem({ entry, conversationId, onChanged, podcastSubject, afterRemoval }: {
  podcastSubject?: PodcastActionSubject; afterRemoval: () => HTMLElement | null;
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
  return <ResourceIndexRow item={entry.item} podcastSubject={podcastSubject} afterRemoval={afterRemoval} occurrenceKey={`${conversationId}/${entry.item.ref}`}
    primaryControl={entry.mutation ? <Button className={styles.remove} ref={removeButton} aria-disabled={busy || stale}
      aria-label={`remove from future context: ${entry.item.label}`} onClick={() => { void remove(); }}>remove</Button> : undefined}
    nestedContent={failure ? <FeedbackNotice content={failure} announcement="Polite"
      actions={[{ label: stale ? "refresh context" : "retry removal", onClick: stale ? () => { refreshRequested.current = true; onChanged(); } : () => { void remove(); }, busy }]} /> : undefined}
  />;
}
