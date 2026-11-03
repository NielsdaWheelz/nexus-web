"use client";
import * as Icon from "@/lib/ui/icons";
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
import { Ruling } from "@/components/feedback/Ruling";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import { useChangeStamp } from "@/lib/api/changes";
import { apiFetch, isApiError, isRefusal, outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { mutateConnection } from "@/lib/resourceGraph/links";
import { admissionReason, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useWritingRuntime } from "@/lib/notes/hooks";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import type { Line, Verbs } from "@/components/feedback/stage";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { resourceType, resourceTypeName } from "@/lib/resources/type";
import { useContextItem } from "@/lib/chat/contextItems";
import { useActionFocusRecovery } from "@/lib/ui/useActionFocusRecovery";
import { definePaneVisitDataKey } from "@/lib/workspace/paneReturnMemento";
import styles from "./ChatContext.module.css";

type Removal = { command: Schema<"ContextOut">["items"][number]["mutation"]; label: string; attempt: number; busy: boolean };
const removalKey = (ref: string, removal: Removal) => `remove ${removal.command.conversation_id}:${ref}:${removal.command.expected_context_version}`;
const VISIT = definePaneVisitDataKey<Visit<Schema<"ContextOut">>>("Chat.Context");

/** The complete future-prompt membership, including missing resources. Versioned removals belong
 * to the visit, not its rows; acceptance or a fresh index proving absence settles them. */
export default function ChatContext({ conversationId, refreshKey }: { conversationId: string; refreshKey: number }) {
  const root = useRef<HTMLElement>(null);
  const paneId = usePaneRuntime()?.paneId;
  const selfRef = `conversation:${conversationId}`;
  const attachments = useConnectionAttachments(selfRef);
  const [adding, setAdding] = useState(false);
  const removals = useResourceDraft<ReadonlyMap<string, Removal>>(`Chat.ContextRemovals:${conversationId}`, () => new Map(),
    value => ({ changed: false, unconfirmed: value.size > 0, stopsBrowserWork: false }));
  const { read: readRemovals, set: setRemovals } = removals;
  const runtime = useWritingRuntime();
  const { say, fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const metadata = useChangeStamp("Notes", "NoteBodies", "Metadata");
  const context = useServerValue<Schema<"ContextOut">>({
    key: `/conversations/${conversationId}/context`, stale: `${refreshKey}:${metadata}`, visit: VISIT,
    load: async (signal) => (await apiFetch<ApiJson<"/conversations/{conversation_id}/context", "get">>(`/api/conversations/${conversationId}/context`, { signal })).data,
  });
  useEffect(() => {
    if (context.status !== "ready" || !context.fresh || context.error !== null) return;
    const present = new Set(context.data.items.map(entry => entry.item.ref));
    const current = readRemovals();
    if (![...current.keys()].some(ref => !present.has(ref))) return;
    setRemovals(new Map([...current].filter(([ref]) => present.has(ref))));
  }, [context, removals.value, readRemovals, setRemovals]);
  const forget = (ref: string) => removals.set(current => { const next = new Map(current); next.delete(ref); return next; });
  const remove = async (ref: string, initial: Pick<Removal, "command" | "label"> | null): Promise<boolean> => {
    const previous = removals.read().get(ref);
    if (previous?.busy) return false;
    const attempt = previous ?? (initial ? { ...initial, attempt: 0, busy: false } : null);
    if (attempt === null) return false;
    removals.set(current => new Map(current).set(ref, { ...attempt, busy: true }));
    const owns = () => removals.read().get(ref)?.command === attempt.command;
    try {
      await mutateConnection(runtime, attempt.command);
      if (!owns()) return false;
      forget(ref);
      void context.refetch();
      return true;
    } catch (error) {
      if (!owns()) return false;
      if (handleUnauthenticatedApiError(error)) { forget(ref); return false; }
      if (outcomeUnknown(error) || (isRefusal(error) && attempt.attempt > 0)) {
        removals.set(current => new Map(current).set(ref, { ...attempt, busy: false, attempt: attempt.attempt + 1 }));
        return false;
      }
      if (isRefusal(error)) forget(ref);
      void context.refetch();
      const fact = `couldn’t remove “${attempt.label}”.`;
      if (isApiError(error) && error.code === "E_CONTEXT_CHANGED") say({ fact, reason: "this chat’s context changed." });
      else fail(error, fact, { label: "retry", commandKey: removalKey(ref, attempt), run: () => void remove(ref, attempt) });
      return false;
    } finally {
      const current = removals.read().get(ref);
      if (current && owns() && current.busy) removals.set(value => new Map(value).set(ref, { ...current, busy: false }));
    }
  };
  const feedbackFor = (ref: string, removal: Removal) => resendFeedback({
    line: { fact: `not sure “${removal.label}” was removed.`, reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: removalKey(ref, removal), busy: removal.busy,
      run: () => { if (removals.read().get(ref)?.command === removal.command) void remove(ref, null); } },
  });
  const entries = context.status === "ready" ? context.data.items : [];
  return <section ref={root} aria-label="Chat context" {...attachments.dropProps}>
    <div className={styles.tools}><ContextualActionMenu navigation={null} resourceRef={assumeCanonicalResourceRef(selfRef)} title="chat context" subjectKey={`context:${selfRef}`} label="more actions for chat context" sections={[{ id: "Pane", actions: [{ kind: "command", id: "Context.Add", label: "Add to future context", icon: <Icon.Add aria-hidden="true" />, onSelect: () => setAdding(true) }] }]} />{attachments.control}</div>
    <p className={styles.metadata}>available to future replies</p>
    {context.status === "loading" ? <Ruling /> : null}
    {context.status === "failed" ? <Failed error={context.error} noun="context items" retry={{ run: () => void context.refetch(), busy: context.retrying }} /> : null}
    {[...removals.value].map(([ref, removal]) => removal.attempt > 0 ? <Hold key={ref} id={`remove:${conversationId}:${ref}`} attempt={removal.attempt} {...feedbackFor(ref, removal)} /> : null)}
    {context.status === "ready" ? <ResourceList ariaLabel="Chat context">
      {entries.map((entry, index) => {
        const pending = removals.value.get(entry.item.ref) ?? null;
        return <ContextIndexItem key={entry.item.ref} entry={entry}
        afterRemoval={() => {
          const candidates = [...entries.slice(index + 1), ...entries.slice(0, index).reverse()];
          for (const candidate of candidates) {
            const link = root.current?.querySelector<HTMLElement>(`[data-resource-ref="${CSS.escape(candidate.item.ref)}"] [data-row-focusable]`);
            if (link?.isConnected && link.getClientRects().length && !link.closest("[inert]")) return link;
          }
          return findPaneLandmarkFocusTarget(paneId);
        }}
        conversationId={conversationId}
        pending={pending}
        recovery={pending !== null && pending.attempt > 0 ? feedbackFor(entry.item.ref, pending) : null}
        onRemove={label => remove(entry.item.ref, { command: entry.mutation, label })} />; })}
      {context.data.items.length === 0 ? <li><Fact line={{ fact: "no context yet." }} /></li> : null}
    </ResourceList> : null}
    {adding ? <ResourceComposer destinationRef={selfRef} occurrenceKey={`context:${selfRef}`} label="add to future context" onSaved={context.refetch} /> : null}
  </section>;
}

/** A context row presents its item. Its visit owns any removal, even when this row is absent. */
function ContextIndexItem({ entry, conversationId, pending, recovery, onRemove, afterRemoval }: {
  afterRemoval: () => HTMLElement | null;
  entry: Schema<"ContextOut">["items"][number]; conversationId: string;
  pending: Removal | null;
  recovery: { line: Line; verbs: Verbs | null } | null;
  onRemove(label: string): Promise<boolean>;
}) {
  const { item, authored, annotation } = useContextItem(entry.item);
  const pane = usePaneRuntime();
  const removeButton = useRef<HTMLButtonElement>(null);
  const waitsId = useId();
  useActionFocusRecovery(removeButton, afterRemoval);
  const parsed = parseResourceRef(entry.item.ref);
  // justify-defect: admitted context refs must satisfy the canonical resource grammar.
  if (parsed === null) throw new Error(`Invalid context ref: ${entry.item.ref}`);
  const type = resourceTypeName(resourceType(parsed.scheme, null));
  const label = item?.label ?? entry.item.label;
  const primary = recovery?.verbs?.[0];
  const replay = primary && "commandKey" in primary && pending !== null && primary.commandKey === removalKey(entry.item.ref, pending) ? primary : null;
  const waits = recovery !== null && (replay === null || replay.busy || replay.disabledReason !== undefined);
  const waitReason = replay?.disabledReason ?? admissionReason() ?? recovery?.line.reason;
  const remove = async () => {
    if (pending?.busy || waits) return;
    if (await onRemove(label) && document.activeElement === removeButton.current) afterRemoval()?.focus({ preventScroll: true });
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
    {waits ? <span id={waitsId} className="sr-only">{waitReason}</span> : null}
    {authored ? <AuthoredReadFailure {...authored} title="couldn’t load this item." /> : null}
    <ResourceIndexRow presentation={{ kind: "Context", primary: item ? { kind: "Item" } : { kind: "Status", label: status }, supportingContent: hasSupport ? supporting : null }} item={item ?? entry.item} afterRemoval={afterRemoval} occurrenceKey={`${conversationId}/${entry.item.ref}`}
    primaryControl={entry.mutation ? <Button ref={removeButton} iconOnly icon={<Icon.Remove />}
      aria-label={`${pending && pending.attempt > 0 ? "retry removing" : "remove from future context"}: ${label}`}
      aria-disabled={pending?.busy || waits || undefined} aria-busy={pending?.busy || replay?.busy || undefined}
      aria-describedby={waits ? waitsId : undefined}
      onClick={() => void remove()} /> : undefined}
    />
  </>;
}
