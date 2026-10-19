"use client";

import { useCallback, useContext, useId, useMemo, useRef, useState, type HTMLAttributes, type AnchorHTMLAttributes, type ReactNode, type Ref } from "react";
import { ChevronRight, CornerLeftUp } from "lucide-react";
import { FeedbackNotice, type FeedbackContent } from "@/components/feedback/Feedback";
import MachineText from "@/components/ui/MachineText";
import { isApiError } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { connectionMutationErrorMessage, endpointForResource, mutateConnection, type ConnectionMutation, type ConnectionOut } from "@/lib/resourceGraph/links";
import { classifyOutlineOccurrence, enterOutlineOccurrence, type OutlineBranch } from "@/lib/resources/outlineProjection";
import { resourceMetadata, type ResourcePresentation } from "@/lib/resources/metadata";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import ContextualActionMenu from "./ContextualActionMenu";
import ResourceBody, { ResourceMatchEvidence, type ResourceMatch } from "./ResourceBody";
import ResourceMetadata from "./ResourceMetadata";
import { ResourceBranch, ResourceOutlineContext } from "./ResourceOutlineList";
import ResourceRow from "@/components/ui/ResourceRow";
import ResourceDisclosure from "./ResourceDisclosure";
import styles from "./ResourceOutline.module.css";

type Item = Schema<"ResourceItemOut">;
type PlacementBranch = {
  expanded: boolean;
  toggle(): void;
  children: ReactNode;
};
const MUTATION_LABEL: Record<ConnectionMutation["kind"], string> = {
  unlink: "remove link from both items; keep their notes",
  dismiss_discovery: "dismiss link",
  detach_context: "remove from future context",
  undo_assistant_write: "undo assistant link",
};

/** shared navigation and controls; supplied bodies retain their owner's interaction.
 * selection is an explicit outline capability. occurrence cues omit redundant identity;
 * focus keeps resource extras visible and hides incoming-relation extras.
 * supplied actions replace the default resource menu. */
export default function ResourceOutlineRow({ item, occurrenceKey, presentation, connection, edgeId, representedEdgeIds = [], embeddedInNoteRef = null, mutationEdgeId, contextMutation, resourceActions = [], occurrenceActions = [], occurrenceLabel, onChanged, onFocusBranch, primaryLinkRef, match, matchMethod, body, annotationEditor, creation, resourceDetails, nestedContent, details, primaryControl, actions, placement, rootProps, bulletProps, rowRef, historical = false }: {
  item: Item;
  occurrenceKey: string;
  presentation?: ResourcePresentation;
  connection?: ConnectionOut;
  edgeId?: string;
  representedEdgeIds?: readonly string[];
  embeddedInNoteRef?: string | null;
  mutationEdgeId?: string;
  contextMutation?: ConnectionMutation;
  resourceActions?: ActionDescriptor[];
  occurrenceActions?: ActionDescriptor[];
  occurrenceLabel?: string;
  onChanged?: () => void;
  onFocusBranch?: () => void;
  primaryLinkRef?: Ref<HTMLAnchorElement>;
  match?: ResourceMatch | null;
  matchMethod?: Schema<"SearchOccurrenceOut">["match_method"] | null;
  body?: ReactNode;
  annotationEditor?: ReactNode;
  resourceDetails?: ReactNode;
  nestedContent?: ReactNode;
  details?: ReactNode;
  primaryControl?: ReactNode;
  creation?: Schema<"ConnectionCreationOut"> | null;
  actions?: ReactNode;
  placement?: PlacementBranch;
  rootProps?: HTMLAttributes<HTMLLIElement> & { "data-active"?: boolean; "data-selected"?: boolean; "data-drop"?: string };
  bulletProps?: AnchorHTMLAttributes<HTMLAnchorElement>;
  rowRef?: Ref<HTMLLIElement>;
  historical?: boolean;
}) {
  const runtime = usePaneRuntime();
  const outline = useContext(ResourceOutlineContext);
  const disclosureDisabled = outline?.viewLocked ?? false;
  const inherited = useContext(ResourceBranch);
  const focus = outline?.view.focused ?? null;
  const focusedRoot = focus === occurrenceKey;
  const branch = useMemo<OutlineBranch>(() => focusedRoot ? { ancestors: new Map(), traversedEdgeIds: new Set() } : inherited, [focusedRoot, inherited]);
  const enteringEdgeId = edgeId ?? connection?.edge_id ?? null;
  const projection = classifyOutlineOccurrence({ branch, targetRef: item.ref, edgeId: focusedRoot ? null : enteringEdgeId });
  const terminal = projection.kind === "reference";
  const childrenBranch = useMemo(() => enterOutlineOccurrence({
    branch,
    ref: item.ref,
    target: focusedRoot ? { kind: "root" } : { kind: "occurrence", key: occurrenceKey },
    edgeIds: focusedRoot ? [] : [...representedEdgeIds, ...(enteringEdgeId === null ? [] : [enteringEdgeId])],
  }), [branch, enteringEdgeId, focusedRoot, item.ref, occurrenceKey, representedEdgeIds]);
  const [localOpen, setLocalOpen] = useState(false);
  const insertion = historical || item.missing ? null : endpointForResource(item.ref);
  const open = projection.kind === "resource" && (placement?.expanded ?? outline?.view.folds.get(occurrenceKey) ?? localOpen);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const submitted = useRef<{ edgeId: string; mutation: ConnectionMutation } | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const element = useRef<HTMLLIElement | null>(null);
  const focusedRowRemoved = outline?.focusedRowRemoved;
  const attachRow = useCallback((node: HTMLLIElement | null) => {
    const previous = element.current;
    element.current = node;
    if (typeof rowRef === "function") rowRef(node);
    else if (rowRef) rowRef.current = node;
    if (node === null && previous !== null && focusedRoot) focusedRowRemoved?.(occurrenceKey, previous);
  }, [focusedRoot, focusedRowRemoved, occurrenceKey, rowRef]);
  const arrow = useRef<HTMLButtonElement | null>(null);
  const childrenId = useId();
  const mutation = focusedRoot ? null : connection?.mutation ?? contextMutation;
  const activation = item.activation;
  const bodyKind = item.preview.body;
  const reason = connection && !focusedRoot ? `${connection.kind === "context" ? "" : `${connection.kind} · `}${connectionReason(connection, historical)}` : null;
  const metadata = resourceMetadata({ item, matchMethod, presentation, occurrenceLabel: focusedRoot ? undefined : occurrenceLabel, reason });
  const unavailable = activation.unavailable_reason === "location_unavailable" ? "quoted location unavailable" : activation.unavailable_reason === "source_unavailable" ? "source unavailable" : null;
  const focusPath = focus !== null && focus.startsWith(`${occurrenceKey}/`);
  const outsideFocus = focus !== null && !focusPath && focus !== occurrenceKey && !occurrenceKey.startsWith(`${focus}/`);

  function toggle() {
    if (disclosureDisabled) return;
    if (open && element.current?.contains(document.activeElement)) arrow.current?.focus({ preventScroll: true });
    if (placement) placement.toggle();
    else if (outline) outline.toggle(occurrenceKey, !open);
    else setLocalOpen(!open);
  }

  function focusBranch() {
    if (disclosureDisabled) return;
    if (onFocusBranch) { onFocusBranch(); return; }
    if (!open) toggle();
    outline?.focus(occurrenceKey);
  }

  async function mutate(retry = false) {
    if (!mutation || busyRef.current) return;
    const command = retry ? submitted.current : { edgeId: enteringEdgeId ?? mutationEdgeId ?? item.ref, mutation };
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

  const commands: ActionDescriptor[] = [...resourceActions, ...(focusedRoot ? [] : occurrenceActions)];
  if (insertion && !terminal) commands.unshift({ kind: "command", id: "Resource.AddItem", label: "add item", onSelect: () => { if (!open) toggle(); } });
  if (activation.kind === "route" && activation.href && runtime) commands.push({
    kind: "command", id: "OpenInNewPane", label: "open in new pane",
    onSelect: () => runtime.activateTarget({ target: { href: activation.href!, labelHint: item.label }, disposition: { kind: "Fork" } }),
  });
  if (activation.href) commands.unshift({ kind: "link", id: "Open", label: "open", href: activation.href });
  if (outline && !terminal && !focusedRoot) commands.push({ kind: "command", id: "Resource.FocusBranch", label: "focus this branch", disabled: disclosureDisabled, disabledReason: disclosureDisabled ? "finish linking first" : undefined, onSelect: focusBranch });
  const made = focusedRoot ? null : creation ?? connection?.creation;
  if (made) commands.push({ kind: "link", id: "Resource.Creation", label: "view creation", href: made.conversation_id && made.message_id ? `/conversations/${made.conversation_id}?message=${made.message_id}` : `/settings/account?generation_id=${made.generation_id}&tool_call_id=${made.tool_call_id}#assistant-writes` });
  const linkedNote = focusedRoot ? null : connection?.link_note?.item;
  if (linkedNote?.activation.href) commands.push({ kind: "link", id: "Resource.LinkNote", label: "edit note on link", href: linkedNote.activation.href });
  const annotation = item.preview.annotation;
  if (annotation?.activation.href) commands.push({ kind: "link", id: "Resource.OpenAnnotation", label: "edit annotation", href: annotation.activation.href });
  if (mutation) commands.push({ kind: "command", id: `Resource.Relation.${mutation.kind}`, label: busy ? "working…" : MUTATION_LABEL[mutation.kind], disabled: busy, disabledReason: busy ? "working…" : undefined, restoreFocusOnClose: false, onSelect: () => void mutate() });
  const boundCommands = commands.map(action => action.kind === "link" && !action.onActivate ? { ...action, onActivate: (event: TargetActivationEvent) => activateTargetLink({ event, runtime, target: { href: action.href } }) } : action);
  if (defect) throw defect.error;
  if (outsideFocus || projection.kind === "omit") return null;
  return <ResourceBranch value={childrenBranch}><ResourceRow primary={{kind:"static"}} title={null} rowRef={attachRow}
    rootProps={{...rootProps,"data-outline-occurrence":occurrenceKey,"data-collection-row-id":occurrenceKey,"data-resource-ref":item.ref,"data-focus-path":focusPath || undefined,"data-outline-focused-root":focusedRoot || undefined}}
    outline={{controls:<>
      {projection.kind === "reference" ? <button ref={arrow} type="button" className={styles.control} disabled={disclosureDisabled} aria-label={`show earlier occurrence of ${item.label}`} title={`show earlier occurrence of ${item.label}`} onClick={() => outline?.reveal(projection.target)} data-row-focusable="true">
        <CornerLeftUp size={14} aria-hidden="true" />
      </button> : <button ref={arrow} type="button" className={styles.control} aria-label={`Expand linked resources for ${item.label}`} aria-expanded={open} aria-controls={open ? childrenId : undefined} disabled={item.missing || disclosureDisabled} onClick={toggle} data-row-focusable="true">
        <ChevronRight size={14} className={styles.arrow} data-open={open || undefined} aria-hidden="true" />
      </button>}
      {activation.href ? <a {...bulletProps} className={cx(styles.control, styles.bullet)} href={activation.href} aria-label={`open ${metadata.identity}: ${item.label}`} data-workspace-rich-target="true" data-row-focusable="true"
        onClick={(event) => activateTargetLink({ event, runtime, target: activation.href ? { href: activation.href, labelHint: item.label } : null })} onKeyDown={(event) => activateTargetLink({ event, runtime, target: activation.href ? { href: activation.href, labelHint: item.label } : null })}>•</a>
        : <span className={cx(styles.control, styles.bullet)} aria-label={unavailable ?? "resource unavailable"} aria-disabled="true">•</span>}
      </>, body:<div className={styles.content}>
        {body ?? <div className={styles.primary}>
          <div className={styles.primaryText}>
            {activation.href ? <a ref={primaryLinkRef} className={styles.primaryLink} href={activation.href} aria-label={`open ${item.label}`} data-workspace-rich-target="true" data-row-focusable="true"
              onClick={(event) => activateTargetLink({ event, runtime, target: activation.href ? { href: activation.href, labelHint: item.label } : null })}
              onKeyDown={(event) => activateTargetLink({ event, runtime, target: activation.href ? { href: activation.href, labelHint: item.label } : null })}
            ><ResourceBody body={item.preview.body} match={match} /></a> : <ResourceBody body={item.preview.body} match={match} />}
          </div>
        </div>}
        {bodyKind.kind === "named" && match?.excerpt.text && match.excerpt.text !== bodyKind.title ? <ResourceMatchEvidence match={match} /> : null}
        {annotationEditor ?? (annotation ? <div className={styles.annotation}><ResourceBody body={annotation.body} /></div> : null)}
        {metadata.parts.length ? <div className={styles.metadata}><ResourceMetadata parts={metadata.parts} linkSource /></div> : null}
        {unavailable ? <p className={styles.status}>{unavailable}</p> : null}
        {resourceDetails}
        {connection && !focusedRoot ? <ConnectionDetails connection={connection} /> : null}
        {/* Hiding a relation must preserve its editor's pending draft identity. */}
        {details ? <div hidden={focusedRoot}>{details}</div> : null}
        {outline && !terminal && !focusedRoot ? <button type="button" className={cx(styles.textButton, styles.narrowFocus)} disabled={disclosureDisabled} onClick={focusBranch}>focus this branch</button> : null}
        {failure && !focusedRoot ? <FeedbackNotice content={failure} announcement="Assertive" actions={[refreshRequired ? { label: "refresh context", onClick: () => { setFailure(null); onChanged?.(); } } : { label: "retry", onClick: () => void mutate(true) }]} /> : null}
      </div>
    }} primaryControl={primaryControl} actions={<div className={styles.actions}>{actions ?? <ContextualActionMenu label={`Actions for ${item.label}`} resourceRef={assumeCanonicalResourceRef(item.action_ref)} omitResourceActions={["Open", "OpenInNewPane"]} sections={[{id:"Occurrence",actions:boundCommands}]} />}</div>}
    expanded={nestedContent || open ? <div className={styles.children}>
      {nestedContent}
      {open ? <div id={childrenId}>
        {placement?.children}
        {placement ? null : <ResourceDisclosure resourceRef={item.ref} occurrencePrefix={occurrenceKey} readOnly={historical} embeddedInNoteRef={focusedRoot ? null : embeddedInNoteRef} />}
      </div> : null}
    </div> : null} /></ResourceBranch>;
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
