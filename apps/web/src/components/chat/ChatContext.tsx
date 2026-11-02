"use client";

import { Minus, Plus } from "lucide-react";
import { useRef, useState } from "react";
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
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useChangeStamp } from "@/lib/api/changes";
import { apiFetch, isApiError, outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { mutateConnection } from "@/lib/resourceGraph/links";
import { MAY_HAVE } from "@/lib/chat/commands";
import { isAuthoredStorageFailure, LocalCommitError } from "@/lib/notes/runtime";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { useContextItem } from "@/lib/chat/contextItems";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./ChatContext.module.css";

const VISIT = definePaneVisitDataKey<Visit<Schema<"ContextOut">>>("Chat.Context");

/** Future prompt membership is an index; removal uses the supplied aggregate version. Only a cold
 * read's failure shows: a failed refresh over shown rows says nothing. */
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
  return <section ref={root} aria-label="Chat context" {...attachments.dropProps}>
    <div className={styles.tools}><ContextualActionMenu navigation={null} resourceRef={assumeCanonicalResourceRef(selfRef)} title="chat context" subjectKey={`context:${selfRef}`} label="more actions for chat context" sections={[{ id: "Pane", actions: [{ kind: "command", id: "Context.Add", label: "Add to future context", icon: <Plus size={16} aria-hidden="true" />, onSelect: () => setAdding(true) }] }]} />{attachments.control}</div>
    <p className={styles.metadata}>available to future replies</p>
    {context.status === "failed" ? <Failed error={context.error} noun="context items" retry={{ run: () => void context.refetch(), busy: context.retrying }} /> : null}
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
      {context.data.items.length === 0 ? <li><Fact line={{ fact: "no context yet." }} /></li> : null}
    </ResourceList> : null}
    {adding ? <ResourceComposer destinationRef={selfRef} occurrenceKey={`context:${selfRef}`} label="add to future context" onSaved={context.refetch} /> : null}
  </section>;
}

/** A refused removal rereads the context at once, so remove works again on what is true now. An
 * unknown one is held until a removal answers; it resends the submitted command. */
function ContextIndexItem({ entry, conversationId, onChanged, afterRemoval }: {
  afterRemoval: () => HTMLElement | null;
  entry: Schema<"ContextOut">["items"][number]; conversationId: string; onChanged: () => Promise<void>;
}) {
  const { item, authored, annotation } = useContextItem(entry.item);
  const pane = usePaneRuntime();
  const { say, fail } = useOutcome();
  const [busy, setBusy] = useState(false);
  /** Attempts whose answer never came; 0 once one answers. */
  const [unknown, setUnknown] = useState(0);
  const submitted = useRef<typeof entry.mutation>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const runtime = useWritingRuntime();
  useActionFocusRecovery(removeButton, afterRemoval);
  // justify-defect: AuthoredProvider mounts its descendants only with a ready account runtime.
  if (runtime === null) throw new Error("chat context requires its writing runtime");
  const parsed = parseResourceRef(entry.item.ref);
  // justify-defect: admitted context refs must satisfy the canonical resource grammar.
  if (parsed === null) throw new Error(`Invalid context ref: ${entry.item.ref}`);
  const type = resourceTypeLabel(parsed.scheme).toLowerCase();
  const label = item?.label ?? entry.item.label;
  const retry = { label: "retry", commandKey: `remove ${entry.item.ref}`, busy, run: () => void remove() };
  const remove = async () => {
    if (busy) return;
    const command = submitted.current ?? entry.mutation;
    if (!command) return;
    submitted.current = command;
    setBusy(true);
    try {
      await mutateConnection(runtime, command);
      submitted.current = null;
      setUnknown(0);
      if (document.activeElement === removeButton.current) afterRemoval()?.focus({ preventScroll: true });
      void onChanged();
    } catch (error) {
      if (handleUnauthenticatedApiError(error) || error instanceof LocalCommitError) return;
      if (outcomeUnknown(error)) return setUnknown((attempt) => attempt + 1);
      submitted.current = null;
      setUnknown(0);
      void onChanged();
      const fact = `couldn’t remove “${label}”.`;
      if (isApiError(error) && error.code === "E_CONTEXT_CHANGED") say({ fact, reason: "this chat’s context changed." });
      else if (isAuthoredStorageFailure(error)) say({ fact });
      else fail(error, fact, retry);
    } finally { setBusy(false); }
  };
  const status = authored?.data ? `${type} unavailable` : type;
  const supporting = <>
    {authored?.data && item === null ? <span>not on this device.</span> : null}
    {annotation ? <a className={styles.note} href={`/highlights/${parsed.id}#annotation`} data-workspace-rich-target="true"
      onClick={event => activateTargetLink({event, runtime: pane, target: {href: `/highlights/${parsed.id}#annotation`, labelHint: item?.label}})}
      onKeyDown={event => activateTargetLink({event, runtime: pane, target: {href: `/highlights/${parsed.id}#annotation`, labelHint: item?.label}})}>
      <span className={styles.notePrefix}>annotation: </span>{annotation.body_text || "rich annotation"}
    </a> : null}
  </>;
  const hasSupport = Boolean(authored?.data && item === null || annotation);
  return <>
    {unknown > 0 ? <Hold id={`remove:${entry.item.ref}`} attempt={unknown} line={{ fact: `not sure “${label}” was removed.`, reason: MAY_HAVE }} verbs={[retry]} /> : null}
    {authored ? <AuthoredReadFailure {...authored} title="couldn’t load this item." /> : null}
    <ResourceIndexRow presentation={{ kind: "Context", primary: item ? { kind: "Item" } : { kind: "Status", label: status }, supportingContent: hasSupport ? supporting : null }} item={item ?? entry.item} afterRemoval={afterRemoval} occurrenceKey={`${conversationId}/${entry.item.ref}`}
    primaryControl={entry.mutation ? <Button ref={removeButton} iconOnly icon={<Minus />}
      aria-label={`${unknown > 0 ? "retry removing" : "remove from future context"}: ${label}`}
      aria-disabled={busy || undefined} aria-busy={busy || undefined}
      onClick={() => void remove()} /> : undefined}
    />
  </>;
}
