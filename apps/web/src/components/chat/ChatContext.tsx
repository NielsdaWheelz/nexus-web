"use client";

import { Minus, Plus, RefreshCw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import { useConnectionAttachments } from "@/components/connections/useConnectionAttachments";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import ResourceList from "@/components/ui/ResourceList";
import ResourceComposer from "@/components/resources/ResourceComposer";
import ResourceIndexRow from "@/components/resources/ResourceIndexRow";
import Button from "@/components/ui/Button";
import { FeedbackFailure, useFeedbackOccurrence, FeedbackStatus } from "@/components/feedback/Feedback";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useChangeStamp } from "@/lib/api/changes";
import { apiFetch, isApiError, outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { connectionMutationErrorMessage, mutateConnection } from "@/lib/resourceGraph/links";
import { LocalCommitError } from "@/lib/notes/runtime";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { useContextItem } from "@/lib/chat/contextItems";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./ChatContext.module.css";

const VISIT = definePaneVisitDataKey<Visit<Schema<"ContextOut">>>("Chat.Context");

/** Future prompt membership is an index; removal uses the supplied aggregate version. */
export default function ChatContext({ conversationId, refreshKey }: { conversationId: string; refreshKey: number }) {
  const root = useRef<HTMLElement>(null);
  const paneId = usePaneRuntime()?.paneId;
  const selfRef = `conversation:${conversationId}`;
  const attachments = useConnectionAttachments(selfRef);
  const [adding, setAdding] = useState(false);
  const metadata = useChangeStamp("Notes", "NoteBodies", "Metadata");
  const context = useServerValue<Schema<"ContextOut">>({
    key: `/conversations/${conversationId}/context`, stale: `${refreshKey}:${metadata}`, visit: VISIT,
    load: async (signal) => (await apiFetch<ApiJson<"/conversations/{conversation_id}/context", "get">>(`/api/conversations/${conversationId}/context`, { signal })).data,
  });
  const entries = context.status === "ready" ? context.data.items : [];
  const failure = context.status === "loading" ? null : context.error;
  const occurrence = useFeedbackOccurrence(failure !== null, selfRef);
  return <section ref={root} aria-label="Chat context" {...attachments.dropProps}>
    <div className={styles.tools}><ContextualActionMenu navigation={null} resourceRef={assumeCanonicalResourceRef(selfRef)} title="chat context" subjectKey={`context:${selfRef}`} label="more actions for chat context" sections={[{ id: "Pane", actions: [{ kind: "command", id: "Context.Add", label: "Add to future context", icon: <Plus size={16} aria-hidden="true" />, onSelect: () => setAdding(true) }] }]} />{attachments.control}</div>
    <p className={styles.metadata}>available to future replies</p>
    {failure ? <FeedbackFailure scope="Local" occurrence={occurrence} content={{ tone: "Warning", title: context.status === "ready" ? "couldn’t refresh connections" : "context couldn’t be loaded", requestId: failure.requestId }} announcement="Assertive" actions={[{ label: context.status === "ready" ? "retry refresh" : "retry", onClick: context.refetch, busy: context.status === "failed" ? context.retrying : context.status === "ready" && context.refreshing }]} /> : null}
    {context.status === "ready" ? <ResourceList ariaLabel="Chat context">
      {entries.map((entry, index) => <ContextIndexItem key={entry.item.ref} entry={entry}
        afterRemoval={() => {
          const candidates = [...entries.slice(index + 1), ...entries.slice(0, index).reverse()];
          for (const candidate of candidates) {
            const link = root.current?.querySelector<HTMLElement>(`[data-resource-ref="${CSS.escape(candidate.item.ref)}"] [data-row-focusable]`);
            if (link?.isConnected && link.getClientRects().length && !link.closest("[inert]")) return link;
          }
          return findPaneLandmarkFocusTarget(paneId);
        }}
        conversationId={conversationId} onChanged={context.refetch} />)}
      {context.data.items.length === 0 ? <li><FeedbackStatus content={{ tone: "Neutral", title: "no context yet" }} announcement="None" /></li> : null}
    </ResourceList> : null}
    {adding ? <ResourceComposer destinationRef={selfRef} occurrenceKey={`context:${selfRef}`} label="add to future context" onSaved={context.refetch} /> : null}
  </section>;
}

function ContextIndexItem({ entry, conversationId, onChanged, afterRemoval }: {
  afterRemoval: () => HTMLElement | null;
  entry: Schema<"ContextOut">["items"][number]; conversationId: string; onChanged: () => Promise<void>;
}) {
  const { item, authored, annotation } = useContextItem(entry.item);
  const pane = usePaneRuntime();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ReturnType<typeof connectionMutationErrorMessage> | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const [stale, setStale] = useState(false);
  const submitted = useRef<typeof entry.mutation>(null);
  const refreshRequested = useRef(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const reasonId = useId();
  const occurrence = useFeedbackOccurrence(failure !== null || busy, entry.item.ref);
  const runtime = useWritingRuntime();
  useActionFocusRecovery(removeButton, afterRemoval);
  if (defect) throw defect.error;
  const remove = async () => {
    if (busy || stale || runtime === null) return;
    const command = submitted.current ?? entry.mutation;
    if (!command) return;
    submitted.current = command;
    setBusy(true);
    try {
      await mutateConnection(runtime, command);
      submitted.current = null;
      if (document.activeElement === removeButton.current) afterRemoval()?.focus({ preventScroll: true });
      void onChanged();
    } catch (error) {
      if (handleUnauthenticatedApiError(error) || error instanceof LocalCommitError) return;
      try {
        const content = connectionMutationErrorMessage(error);
        const shown = isApiError(error) && error.code === "E_CONTEXT_CHANGED" ? { ...content, title: "future context changed; refresh before removing this item" } : content;
        setFailure(shown);
      } catch (error) { setDefect({ error }); }
      if (!outcomeUnknown(error)) {
        submitted.current = null;
        refreshRequested.current = false;
        setStale(true);
      }
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!stale || !refreshRequested.current) return;
    refreshRequested.current = false;
    setStale(false);
    setFailure(null);
  }, [entry.mutation, stale]);
  const parsed = parseResourceRef(entry.item.ref);
  // justify-defect: admitted context refs must satisfy the canonical resource grammar.
  if (parsed === null) throw new Error(`Invalid context ref: ${entry.item.ref}`);
  const type = resourceTypeLabel(parsed.scheme).toLowerCase();
  const label = item?.label ?? entry.item.label;
  const status = authored?.data ? `${type} unavailable` : type;
  const supporting = <>
    {authored?.data && item === null ? <span>not available on this device</span> : null}
    {annotation ? <a className={styles.note} href={`/highlights/${parsed.id}#annotation`} data-workspace-rich-target="true"
      onClick={event => activateTargetLink({event, runtime: pane, target: {href: `/highlights/${parsed.id}#annotation`, labelHint: item?.label}})}
      onKeyDown={event => activateTargetLink({event, runtime: pane, target: {href: `/highlights/${parsed.id}#annotation`, labelHint: item?.label}})}>
      <span className={styles.notePrefix}>annotation: </span>{annotation.body_text || "rich annotation"}
    </a> : null}
  </>;
  const hasSupport = Boolean(authored?.data && item === null || annotation);
  return <>
    {failure ? <FeedbackFailure scope="Local" occurrence={occurrence} content={failure} announcement="Polite" actions={[{label: stale ? "refresh future context" : "retry removing", onClick: () => {if (stale) {refreshRequested.current = true; void onChanged();} else void remove();}, busy}]} /> : null}
    {authored ? <AuthoredReadFailure {...authored} title="couldn’t load this item" /> : null}
    <ResourceIndexRow presentation={{ kind: "Context", primary: item ? { kind: "Item" } : { kind: "Status", label: status }, supportingContent: hasSupport ? supporting : null }} item={item ?? entry.item} afterRemoval={afterRemoval} occurrenceKey={`${conversationId}/${entry.item.ref}`}
    attention={failure ? [failure.title, failure.message].filter(Boolean).join(" · ") : undefined}
    primaryControl={entry.mutation ? <>
      <Button ref={removeButton} iconOnly icon={stale ? <RefreshCw /> : <Minus />}
        aria-label={`${stale ? "refresh future context before removing" : failure ? "retry removing from future context" : "remove from future context"}: ${label}`}
        aria-disabled={busy || runtime === null || undefined} aria-busy={busy || undefined}
        aria-describedby={runtime === null ? reasonId : undefined} tooltip={runtime === null ? { text: "local writing is unavailable" } : undefined}
        onClick={() => { if (stale) { refreshRequested.current = true; void onChanged(); } else void remove(); }} />
      {runtime === null ? <span id={reasonId} className="sr-only">local writing is unavailable</span> : null}
    </> : undefined}
    />
  </>;
}
