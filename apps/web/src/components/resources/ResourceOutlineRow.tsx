"use client";

import { useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type HTMLAttributes, type AnchorHTMLAttributes, type ReactNode, type Ref } from "react";
import { ChevronRight } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import MachineText from "@/components/ui/MachineText";
import { isApiError } from "@/lib/api/client";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerList } from "@/lib/api/useServerList";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { creditName } from "@/lib/contributors/credits";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { connectionMutationErrorMessage, mutateConnection, queryConnections, subscribeLinkMutations, type ConnectionMutation, type ConnectionOut } from "@/lib/resourceGraph/links";
import { parseResourceRef, resourceTypeLabel } from "@/lib/resourceGraph/resourceRef";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import ContextualActionMenu from "./ContextualActionMenu";
import ResourceBody, { ResourceMatchEvidence, type ResourceMatch } from "./ResourceBody";
import ResourceOutlineList, { ResourceAncestors, ResourceOutlineContext } from "./ResourceOutlineList";
import styles from "./ResourceOutline.module.css";

type Item = Schema<"ResourceItemOut">;
type PlacementBranch = {
  expanded: boolean;
  ready: boolean;
  toggle(): void;
  children: ReactNode;
  edgeIds: ReadonlySet<string>;
};
const MUTATION_LABEL: Record<ConnectionMutation["kind"], string> = {
  unlink: "remove link",
  dismiss_discovery: "dismiss link",
  detach_context: "remove from future context",
  undo_assistant_write: "undo assistant link",
};

/** Shared content and controls; an outline editor supplies only its owned body/placements. */
export default function ResourceOutlineRow({ item, occurrenceKey, connection, contextMutation, mutationEdgeId, occurrenceActions = [], occurrenceLabel, onChanged, onFocusBranch, match, body, annotationEditor, creation, details, primaryControl, menu, placement, rootProps, bulletProps, rowRef, historical = false }: {
  item: Item;
  occurrenceKey: string;
  connection?: ConnectionOut;
  contextMutation?: ConnectionMutation;
  mutationEdgeId?: string;
  occurrenceActions?: ActionDescriptor[];
  occurrenceLabel?: string;
  onChanged?: () => void;
  onFocusBranch?: () => void;
  match?: ResourceMatch | null;
  body?: ReactNode;
  annotationEditor?: ReactNode;
  details?: ReactNode;
  primaryControl?: ReactNode;
  creation?: Schema<"ConnectionCreationOut"> | null;
  menu?: ReactNode;
  placement?: PlacementBranch;
  rootProps?: HTMLAttributes<HTMLLIElement> & { "data-active"?: boolean; "data-selected"?: boolean; "data-drop"?: string };
  bulletProps?: AnchorHTMLAttributes<HTMLAnchorElement>;
  rowRef?: Ref<HTMLLIElement>;
  historical?: boolean;
}) {
  const runtime = usePaneRuntime();
  const outline = useContext(ResourceOutlineContext);
  const ancestors = useContext(ResourceAncestors);
  const ancestor = ancestors.get(item.ref);
  const cycle = ancestor !== undefined;
  const childrenAncestors = useMemo(() => new Map(ancestors).set(item.ref, occurrenceKey), [ancestors, item.ref, occurrenceKey]);
  const [localOpen, setLocalOpen] = useState(false);
  const open = !cycle && (placement?.expanded ?? outline?.view.folds.get(occurrenceKey) ?? localOpen);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const submitted = useRef<{ edgeId: string; mutation: ConnectionMutation } | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const element = useRef<HTMLLIElement | null>(null);
  const arrow = useRef<HTMLButtonElement | null>(null);
  const childrenId = useId();
  const mutation = connection?.mutation ?? contextMutation;
  const activation = item.activation;
  const source = item.preview.source;
  const sourceLabel = source?.title ?? "source";
  const passage = item.preview.body.kind === "passage";
  const parsed = parseResourceRef(item.ref);
  const type = parsed ? resourceTypeLabel(parsed.scheme).toLowerCase() : "resource";
  const bodyKind = item.preview.body;
  const contributors = source?.contributors ?? (bodyKind.kind === "named" ? bodyKind.contributors : null);
  const names = (contributors ?? []).flatMap((credit) => creditName(credit)?.label ?? []);
  const mediaKind = source?.media_kind ?? (bodyKind.kind === "named" ? bodyKind.media_kind : null);
  const reason = connection ? `${connection.kind === "context" ? "" : `${connection.kind} · `}${connectionReason(connection, historical)}` : null;
  const unavailable = activation.unavailable_reason === "location_unavailable" ? "quoted location unavailable" : activation.unavailable_reason === "source_unavailable" ? "source unavailable" : null;
  const focus = outline?.view.focused ?? null;
  const focusPath = focus !== null && focus.startsWith(`${occurrenceKey}/`);
  const outsideFocus = focus !== null && !focusPath && focus !== occurrenceKey && !occurrenceKey.startsWith(`${focus}/`);

  function toggle() {
    if (open && element.current?.contains(document.activeElement)) arrow.current?.focus({ preventScroll: true });
    if (placement) placement.toggle();
    else if (outline) outline.toggle(occurrenceKey, !open);
    else setLocalOpen(!open);
  }

  function focusBranch() {
    if (onFocusBranch) { onFocusBranch(); return; }
    if (!open) toggle();
    outline?.focus(occurrenceKey);
    requestAnimationFrame(() => arrow.current?.focus({ preventScroll: true }));
  }

  async function mutate(retry = false) {
    if (!mutation || busyRef.current) return;
    const command = retry ? submitted.current : { edgeId: connection?.edge_id ?? mutationEdgeId ?? item.ref, mutation };
    if (!command) return;
    submitted.current = command;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setRefreshRequired(false);
    const row = element.current;
    const neighbours = [row?.nextElementSibling, row?.previousElementSibling, row?.parentElement?.closest("li"), row?.parentElement]
      .flatMap((node) => node ? [node.querySelector<HTMLElement>("[data-row-focusable]:not(:disabled)") ?? node as HTMLElement] : []);
    let ownsFocus = true;
    const release = () => { ownsFocus = false; };
    document.addEventListener("pointerdown", release, true);
    document.addEventListener("keydown", release, true);
    try {
      await mutateConnection(command.edgeId, command.mutation);
      submitted.current = null;
      onChanged?.();
      if (ownsFocus && (row?.contains(document.activeElement) || document.activeElement === document.body))
        neighbours.find((node) => node.isConnected)?.focus({ preventScroll: true });
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        try {
          setFailure(connectionMutationErrorMessage(error));
          if (isApiError(error) && error.code === "E_CONTEXT_CHANGED") { submitted.current = null; setRefreshRequired(true); }
        } catch (error) { setDefect({ error }); }
      }
    } finally {
      document.removeEventListener("pointerdown", release, true);
      document.removeEventListener("keydown", release, true);
      busyRef.current = false;
      setBusy(false);
    }
  }

  const commands: ActionDescriptor[] = [...occurrenceActions];
  if (activation.kind === "route" && activation.href && runtime) commands.push({
    kind: "command", id: "OpenInNewPane", label: "open in new pane",
    onSelect: () => runtime.activateTarget({ target: { href: activation.href!, labelHint: item.label }, disposition: { kind: "Fork" } }),
  });
  if (activation.href) commands.unshift({ kind: "link", id: "Open", label: "open", href: activation.href });
  if (outline && !cycle) commands.push({ kind: "command", id: "Resource.FocusBranch", label: "focus this branch", onSelect: focusBranch });
  const made = creation ?? connection?.creation;
  if (made) commands.push({ kind: "link", id: "Resource.Creation", label: "view creation", href: made.conversation_id && made.message_id ? `/conversations/${made.conversation_id}?message=${made.message_id}` : `/settings/account?generation_id=${made.generation_id}&tool_call_id=${made.tool_call_id}#assistant-writes` });
  const linkedNote = connection?.link_note?.item;
  if (linkedNote?.activation.href) commands.push({ kind: "link", id: "Resource.LinkNote", label: "edit note on link", href: linkedNote.activation.href });
  const annotation = item.preview.annotation;
  if (annotation?.activation.href) commands.push({ kind: "link", id: "Resource.OpenAnnotation", label: "edit annotation", href: annotation.activation.href });
  if (mutation) commands.push({ kind: "command", id: `Resource.Relation.${mutation.kind}`, label: busy ? "working…" : MUTATION_LABEL[mutation.kind], disabled: busy, disabledReason: busy ? "working…" : undefined, restoreFocusOnClose: false, onSelect: () => void mutate() });
  const boundCommands = commands.map(action => action.kind === "link" && !action.onActivate ? { ...action, onActivate: (event: TargetActivationEvent) => activateTargetLink({ event, runtime, target: { href: action.href } }) } : action);
  if (defect) throw defect.error;
  if (outsideFocus) return null;
  return <li {...rootProps} ref={(node) => { element.current = node; if (typeof rowRef === "function") rowRef(node); else if (rowRef) rowRef.current = node; }}
    className={cx(styles.row, rootProps?.className)} data-outline-occurrence={occurrenceKey} data-collection-row-id={occurrenceKey} data-resource-ref={item.ref} data-focus-path={focusPath || undefined}>
    <div className={cx(styles.head, Boolean(primaryControl) && styles.withPrimaryControl)}>
      <button ref={arrow} type="button" className={styles.control} aria-label={`Expand linked resources for ${item.label}`} aria-expanded={open} aria-controls={open ? childrenId : undefined} disabled={cycle || item.missing} onClick={toggle} data-row-focusable="true">
        <ChevronRight size={14} className={styles.arrow} data-open={open || undefined} aria-hidden="true" />
      </button>
      {activation.href ? <a {...bulletProps} className={cx(styles.control, styles.bullet)} href={activation.href} aria-label={`Open ${passage ? "passage" : "resource"}: ${item.label}`} data-workspace-rich-target="true" data-row-focusable="true"
        onClick={(event) => activateTargetLink({ event, runtime, target: activation.href ? { href: activation.href, labelHint: item.label } : null })} onKeyDown={(event) => activateTargetLink({ event, runtime, target: activation.href ? { href: activation.href, labelHint: item.label } : null })}>•</a>
        : <span className={cx(styles.control, styles.bullet)} aria-label={unavailable ?? "resource unavailable"} aria-disabled="true">•</span>}
      <div className={styles.content}>
        {body ?? <div className={styles.primary}><ResourceBody body={item.preview.body} match={match} /></div>}
        {bodyKind.kind === "named" && match?.excerpt.text && match.excerpt.text !== bodyKind.title ? <ResourceMatchEvidence match={match} /> : null}
        {annotationEditor ?? (annotation ? <div className={styles.annotation}><ResourceBody body={annotation.body} /></div> : null)}
        <div className={styles.metadata}>
          {occurrenceLabel ? <><span>{occurrenceLabel}</span><span aria-hidden="true">·</span></> : null}
          <span>{type}{bodyKind.kind === "prose" && bodyKind.role ? ` · ${bodyKind.role}` : ""}{mediaKind && mediaKind !== type ? ` · ${mediaKind.replaceAll("_", " ")}` : ""}</span>
          {source && (source.title || source.activation?.href) && !(bodyKind.kind === "named" && source.ref === item.ref && source.title === bodyKind.title) ? <><span aria-hidden="true">·</span>{source.activation?.href ? <a className={styles.source} href={source.activation.href} aria-label={`Open source: ${sourceLabel}`} data-workspace-rich-target="true" onClick={(event) => activateTargetLink({ event, runtime, target: source.activation?.href ? { href: source.activation.href, labelHint: source.title ?? undefined } : null })} onKeyDown={(event) => activateTargetLink({ event, runtime, target: source.activation?.href ? { href: source.activation.href, labelHint: source.title ?? undefined } : null })}>{sourceLabel}</a> : <span>{sourceLabel}</span>}</> : null}
          {names.length ? <><span aria-hidden="true">·</span><span>{names.slice(0, 2).join(", ")}{names.length > 2 ? ` and ${names.length - 2} others` : ""}</span></> : null}
          {source?.location_label ? <><span aria-hidden="true">·</span><span>{source.location_label}</span></> : null}
          {reason ? <><span aria-hidden="true">·</span><span>{reason}</span></> : null}
        </div>
        {unavailable ? <p className={styles.status}>{unavailable}</p> : null}
        {cycle ? <button type="button" className={styles.textButton} onClick={() => {
          outline?.focus(null);
          const root = element.current?.closest("[data-outline-scope]");
          const target = root?.querySelector<HTMLElement>(`[data-outline-occurrence="${CSS.escape(ancestor)}"] [data-row-focusable]`) ?? root?.querySelector<HTMLElement>("ul");
          requestAnimationFrame(() => target?.focus());
        }}>already shown above</button> : null}
        {connection ? <ConnectionDetails connection={connection} /> : null}
        {details}
        {outline && !cycle && focus !== occurrenceKey ? <button type="button" className={cx(styles.textButton, styles.narrowFocus)} onClick={focusBranch}>focus this branch</button> : null}
        {failure ? <FeedbackNotice content={failure} announcement="Assertive" actions={[refreshRequired ? { label: "refresh context", onClick: () => { setFailure(null); onChanged?.(); } } : { label: "retry", onClick: () => void mutate(true) }]} /> : null}
      </div>
      {primaryControl ? <div className={styles.primaryControl}>{primaryControl}</div> : null}
      <div className={styles.actions}>{menu ?? <ContextualActionMenu label={`Actions for ${item.label}`} resourceRef={assumeCanonicalResourceRef(item.action_ref)} omitResourceActions={["Open", "OpenInNewPane"]} sections={[{ id: "Occurrence", actions: boundCommands }]} />}</div>
    </div>
    {open ? <ResourceAncestors value={childrenAncestors}><div id={childrenId} className={styles.children}>
      {placement?.children}
      <div hidden={placement !== undefined && !placement.ready}><ResourceConnections resourceRef={item.ref} scope={`${occurrenceKey}/links`} occurrencePrefix={occurrenceKey} excludeEdgeIds={placement?.edgeIds} historical={historical} /></div>
    </div></ResourceAncestors> : null}
  </li>;
}

function connectionReason(connection: ConnectionOut, historical: boolean): string {
  if (connection.origin === "citation") return connection.direction === "incoming" ? "cited by" : "cites";
  return connectionOriginLabel(connection.origin, historical);
}

export function connectionOriginLabel(origin: ConnectionOut["origin"], historical = false): string {
  if (historical && origin === "highlight_note") return "current annotation";
  switch (origin) {
    case "user": return "linked by you";
    case "citation": return "citation";
    case "discovery": return "connection discovery";
    case "assistant": return "assistant-created link";
    case "system": return "added to chat";
    case "highlight_note": return "annotation";
    case "link_note": return "note on link";
    case "note_body": return "embedded resource";
    case "document_embed": return "attachment";
  }
}

function ConnectionDetails({ connection }: { connection: ConnectionOut }) {
  const machine = connection.origin === "discovery" || connection.origin === "assistant";
  const rationale = connection.snapshot?.rationale;
  return <>
    {machine && rationale ? <div className={styles.details}><MachineText variant="inline" origin={{ label: connection.origin === "discovery" ? "Connection discovery" : "Assistant" }}>{rationale}</MachineText></div> : null}
    {connection.link_note ? <div className={styles.details}><span className={styles.quiet}>note on link</span><ResourceBody body={connection.link_note.item.preview.body} /></div> : null}
  </>;
}

/** One lazy, paged hop; expansion does not admit anything to chat context. */
export function ResourceConnections({ resourceRef, scope, occurrencePrefix, excludeEdgeIds, historical = false, rollup = "exact" }: {
  resourceRef: string;
  scope: string;
  occurrencePrefix: string;
  excludeEdgeIds?: ReadonlySet<string>;
  historical?: boolean;
  rollup?: "exact" | "owner";
}) {
  const [revision, setRevision] = useState(0);
  const changed = useChangeStamp("Notes", "Metadata");
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => subscribeLinkMutations(refresh), [refresh]);
  const list = usePaneFreeServerList<ConnectionOut>({
    key: resourceRef, stale: `${revision}:${changed}`, pageSize: 40, drain: false, active: true,
    id: (connection) => connection.edge_id,
    fetchPage: async (cursor, limit, signal) => {
      const page = await queryConnections({ refs: [resourceRef], direction: "both", rollup, limit, cursor }, signal);
      return { items: page.items, next_cursor: page.next_cursor };
    },
  });
  const items = list.items.filter((connection) => !excludeEdgeIds?.has(connection.edge_id));
  return <>
    {list.status !== "ready" && !list.failure ? <p role="status" className={styles.status}>loading linked resources…</p> : null}
    {list.failure ? <p role="alert" className={styles.status}>couldn’t load linked resources <button type="button" className={styles.textButton} onClick={list.retry}>retry</button></p> : null}
    {list.current && list.complete && items.length === 0 && !excludeEdgeIds?.size ? <p className={styles.status}>no linked resources</p> : null}
    <ResourceOutlineList scope={scope} ariaLabel="Linked resources" ancestorRef={resourceRef} busy={list.running !== null}>
      {items.map((connection) => <ResourceOutlineRow key={connection.edge_id} item={connection.other} occurrenceKey={`${occurrencePrefix}/${connection.edge_id}`} connection={connection} onChanged={refresh} historical={historical} />)}
    </ResourceOutlineList>
    {list.current && !list.complete ? <button type="button" className={styles.textButton} disabled={list.running !== null} onClick={list.more}>{list.running === "More" ? "loading linked resources…" : "show more"}</button> : null}
  </>;
}
