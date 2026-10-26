"use client";

// One occurrence of a resource in an outline branch. Authored refs (notes, pages,
// highlights) always render from the local store by ref, whichever prop supplied
// them: a server item never replaces local writing. Other refs render their server
// item; by ref they show the local source stub's literal label until it arrives.
// The occurrence owns only its relationship menu (its outline's unlink, server-fact
// removal); structure keys, selection and ordering belong to the outline's rootProps.
// Writing rows keep native bullet navigation first and local disclosure last.
// Their prepared projection owns first-render identity and navigation; browsing rows read theirs.
// Browsing rows also disclose server facts.
// Local occurrence actions never wait for a remote resource menu.
import {useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type HTMLAttributes, type ReactNode, type Ref} from "react";
import {ChevronRight, CornerLeftUp} from "lucide-react";
import type {ResourceProjection} from "@nexus/authored/types";
import Button from "@/components/ui/Button";
import MachineText from "@/components/ui/MachineText";
import {FeedbackNotice, FeedbackStatus, type FeedbackAction, type FeedbackContent} from "@/components/feedback/Feedback";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import BoundPageTitleEditor from "@/components/notes/BoundPageTitleEditor";
import LocalOutline from "@/components/notes/LocalOutline";
import type {ActionMenuContextAnchorProps} from "@/components/ui/ActionMenu";
import {useChangeStamp} from "@/lib/api/changes";
import {isApiError} from "@/lib/api/client";
import {assertNever} from "@/lib/assertNever";
import {usePaneFreeServerValue} from "@/lib/api/serverState";
import type {Schema} from "@/lib/api/wire";
import {handleUnauthenticatedApiError} from "@/lib/auth/UnauthenticatedApiBoundary";
import {useResolvedResourceItem} from "@/lib/media/mediaSummary";
import {useAuthoredQuery, useWritingRuntime} from "@/lib/notes/hooks";
import type {WritingRuntime} from "@/lib/notes/runtime";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import {activateTargetLink} from "@/lib/panes/targetLinkActivation";
import {connectionMutationErrorMessage, mutateConnection, type ConnectionMutation, type ConnectionOut} from "@/lib/resourceGraph/links";
import {parseResourceRef, resourceTypeLabel} from "@/lib/resourceGraph/resourceRef";
import {resolveResourceItem} from "@/lib/resources/items";
import {localResourceHref, localResourceLabel} from "@/lib/resources/localResource";
import {resourceMetadata} from "@/lib/resources/metadata";
import {classifyOutlineOccurrence, enterOutlineOccurrence} from "@/lib/resources/outlineProjection";
import {assumeCanonicalResourceRef} from "@/lib/sharing/targets";
import type {ActionDescriptor} from "@/lib/ui/actionDescriptor";
import {cx} from "@/lib/ui/cx";
import RemoteConnections, {useRemoteConnections} from "@/components/connections/RemoteConnections";
import ContextualActionMenu from "./ContextualActionMenu";
import ResourceBody, {ResourceMatchEvidence, type ResourceMatch} from "./ResourceBody";
import ResourceMetadata from "./ResourceMetadata";
import {ResourceBranch, ResourceOutlineContext} from "./ResourceOutlineList";
import styles from "./ResourceOutline.module.css";
import factualStyles from "./ResourceContent.module.css";

type Item = Schema<"ResourceItemOut">;
const EMPTY_EDGE_IDS: readonly string[] = [];
const NO_SUBSCRIPTION = () => () => {};
const IDLE = {saving: false, error: null as unknown, error_refs: [] as string[], revision: 0};
const IDLE_SAVE = () => IDLE;
type PlacementBranch = {expanded: boolean; toggle(): void; children: ReactNode};
/** How the occurrence entered its branch: a local user link, a server fact, or a root.
 * The outline rendering a local link owns its unlink: execution, undo, focus, and any
 * failed commit's retry at the outline root, which outlives this row. */
export type Incoming =
  | {kind: "link"; linkId: string; parentLabel: string; unlink(): void}
  | {kind: "edge"; edge_id: string; origin: ConnectionOut["origin"]; mutation: ConnectionMutation | null;
    creation: ConnectionOut["creation"]}
  | null;
type Shared = {
  occurrenceKey: string;
  onSelectBlock?: () => void;
  incoming: Incoming;
  connection?: ConnectionOut;
  representedEdgeIds?: readonly string[];
  occurrenceLabel?: string;
  onChanged?: () => void;
  primaryLinkRef?: Ref<HTMLAnchorElement>;
  match?: ResourceMatch | null;
  matchMethod?: Schema<"SearchOccurrenceOut">["match_method"] | null;
  body?: ReactNode;
  sourceContent?: ReactNode;
  resourceDetails?: ReactNode;
  nestedContent?: ReactNode;
  details?: ReactNode;
  commandDisabledReason?: string;
  omitResourceActions?: readonly string[];
  placement?: PlacementBranch;
  rootProps?: HTMLAttributes<HTMLElement> & {"data-active"?: boolean; "data-selected"?: boolean};
  rowRef?: Ref<HTMLLIElement>;
  historical?: boolean;
  /** Local note editing; terminal and historical occurrences never edit. */
  editable?: boolean;
  annotationFocusRequest?: number | null;
  onAnnotationClose?: () => void;
} & (
  /** Writing rows disclose authored links only; their outline prepares presentation and availability. */
  | {writing: true; projection: ResourceProjection; childrenAvailable: boolean | null}
  | {writing?: false; projection?: never; childrenAvailable?: never}
);
type Props = ({item: Item; resourceRef?: never} | {resourceRef: string; item?: never}) & Shared;
/** What the shared occurrence chrome shows for one resource. */
interface Presentation {
  ref: string;
  label: string;
  identity: string;
  href: string | null;
  primary: ReactNode;
  item: Item | null;
  /** A local highlight's id: attached notes are its children; `add note` composes one. */
  highlightId: string | null;
  status: ReactNode;
}

const AUTHORED = /^(note_block|page|highlight):/u;
/** A server fact's removal, when its owner offers one; local links unlink through their outline. */
function factRemoval(incoming: Extract<Incoming, {kind: "edge"}>, writing: WritingRuntime): {id: string; label: string; run(): Promise<unknown>} | null {
  const mutation = incoming.mutation;
  if (mutation === null) return null;
  switch (mutation.kind) {
    case "detach_context": return {id: mutation.kind, label: "remove from future context", run: () => mutateConnection(writing, mutation)};
    case "remove_fact": return {id: mutation.kind, label: "remove suggested connection",
      run: () => mutateConnection(writing, {kind: "remove_fact", edge_id: incoming.edge_id})};
    default: return assertNever(mutation);
  }
}

export default function ResourceOutlineRow({item, resourceRef, ...shared}: Props) {
  if (item !== undefined && !AUTHORED.test(item.ref)) return <RemoteRow {...shared} item={item}/>;
  const ref = item?.ref ?? resourceRef!;
  return AUTHORED.test(ref) ? <AuthoredRow {...shared} subject={ref}/> : <ReferenceRow {...shared} subject={ref}/>;
}

/** A server item's presentation; shared so a by-ref row keeps one Occurrence while its item arrives. */
function remotePresentation(item: Item, props: Shared, runtime: ReturnType<typeof usePaneRuntime>): Presentation {
  const metadata = resourceMetadata({item, matchMethod: props.matchMethod, occurrenceLabel: props.occurrenceLabel});
  const activation = item.activation;
  const unavailable = activation.unavailable_reason === "location_unavailable" ? "quoted location unavailable"
    : activation.unavailable_reason === "source_unavailable" ? "source unavailable" : null;
  const content = <ResourceBody body={item.preview.body} match={props.match}/>;
  return {
    ref: item.ref, label: item.label, identity: metadata.identity, href: activation.href, item, highlightId: null,
    primary: <div className={styles.reference}>
      {activation.href ? <a ref={props.primaryLinkRef} className={styles.primaryLink} href={activation.href}
        aria-label={`open ${item.label}`} data-workspace-rich-target="true"
        onClick={event => activateTargetLink({event, runtime, target: {href: activation.href!, labelHint: item.label}})}
        onKeyDown={event => activateTargetLink({event, runtime, target: {href: activation.href!, labelHint: item.label}})}>
        {content}</a> : content}
      {metadata.bibliography.length ? <span className={factualStyles.bibliography}><span className={styles.separator}> · </span>
        <ResourceMetadata parts={metadata.bibliography} linkSource={false}/></span> : null}
    </div>,
    status: <>
      {item.preview.body.kind === "named" && props.match?.excerpt.text && props.match.excerpt.text !== item.preview.body.title
        ? <ResourceMatchEvidence match={props.match}/> : null}
      {metadata.parts.length ? <div className={styles.metadata}><ResourceMetadata parts={metadata.parts} linkSource/></div> : null}
      {unavailable ? <p className={styles.status}>{unavailable}</p> : null}
    </>,
  };
}

function RemoteRow(props: Shared & {item: Item}) {
  const item = useResolvedResourceItem(props.item, props.historical);
  return <Occurrence {...props} presentation={remotePresentation(item, props, usePaneRuntime())}/>;
}

/** A non-authored ref: the stub's literal capture until the server item arrives, in one Occurrence. */
function ReferenceRow(props: Shared & {subject: string}) {
  const runtime = usePaneRuntime();
  const remote = usePaneFreeServerValue<Item>({key: props.historical ? null : `/resource-items/${props.subject}`, stale: useChangeStamp("Metadata"),
    load: signal => resolveResourceItem(props.subject, signal)});
  const local = useAuthoredQuery(props.writing || remote.status === "ready" ? null : {kind: "resource", ref: props.subject});
  const stub = props.writing ? props.projection : local.data?.rows[0]?.resource ?? null;
  const parsed = parseResourceRef(props.subject);
  // Absent locally and still being read remotely is not yet "unavailable": show the literal ref.
  const settled = props.historical || remote.status === "failed";
  const label = stub ? localResourceLabel(stub) : settled ? "unavailable resource" : props.subject;
  return <Occurrence {...props} presentation={remote.status === "ready" ? {...remotePresentation(remote.data, props, runtime), ref: props.subject} : {
    ref: props.subject, label, identity: parsed ? resourceTypeLabel(parsed.scheme).toLowerCase() : "resource",
    href: stub ? localResourceHref(stub) : null, item: null, highlightId: null,
    primary: <span data-resource-primary className={factualStyles.named}>{label}</span>,
    status: local.error ? <FeedbackNotice content={{tone: "Warning", title: "couldn’t read this on this device"}}
      announcement="Polite" actions={[{label: "retry", onClick: local.retry}]}/>
      : !stub && local.data && settled ? <p className={styles.status}>not available on this device</p> : null,
  }}/>;
}

function AuthoredRow(props: Shared & {subject: string}) {
  const read = useAuthoredQuery(props.writing ? null : {kind: "resource", ref: props.subject});
  const resource = props.writing ? props.projection : read.data?.rows[0]?.resource ?? null;
  const source = useAuthoredQuery(resource?.kind === "highlight" && resource.source_ref ? {kind: "resource", ref: resource.source_ref} : null);
  const runtime = usePaneRuntime();
  const writing = useWritingRuntime();
  const saving = useSyncExternalStore(writing?.subscribe ?? NO_SUBSCRIPTION, writing?.snapshot ?? IDLE_SAVE, IDLE_SAVE);
  const branch = useContext(ResourceBranch);
  const parsed = parseResourceRef(props.subject)!;
  const label = resource ? localResourceLabel(resource) : parsed.scheme === "note_block" ? "unavailable note"
    : parsed.scheme === "page" ? "unavailable page" : "unavailable highlight";
  const identity = resourceTypeLabel(parsed.scheme).toLowerCase();
  const terminal = classifyOutlineOccurrence({branch, targetRef: props.subject, edgeId: null}).kind === "reference";
  const editable = (props.editable ?? true) && !props.historical && !terminal;
  const href = resource ? localResourceHref(resource) : null;
  const link = (children: ReactNode) => href ? <a ref={props.primaryLinkRef} className={styles.primaryLink} href={href}
    aria-label={`open ${label}`} data-workspace-rich-target="true"
    onClick={event => activateTargetLink({event, runtime, target: {href, labelHint: label}})}
    onKeyDown={event => activateTargetLink({event, runtime, target: {href, labelHint: label}})}>{children}</a> : children;
  const sourceLabel = source.data?.rows[0]?.resource;
  const primary = !resource ? <span className={factualStyles.quiet}>{read.data ? "no longer available on this device" : "opening…"}</span>
    : resource.kind === "note" ? <BoundNoteEditor noteRef={props.subject} label={`edit note: ${label}`} editable={editable}/>
    : resource.kind === "page" ? <BoundPageTitleEditor pageRef={props.subject} label={`edit page title: ${label}`} editable={editable}
      placeholder={resource.local_date ?? "untitled page"}/>
    : resource.kind === "highlight" ? <div className={styles.reference}>
      {link(<span data-resource-primary className={factualStyles.passage}>
        <mark className={factualStyles.exact} data-color={resource.color ?? undefined}>{resource.selection?.quote_exact || "selected region"}</mark>
      </span>)}
      {sourceLabel ? <span className={factualStyles.bibliography}><span className={styles.separator}> · </span>{localResourceLabel(sourceLabel)}</span> : null}
    </div>
    : <span data-resource-primary className={factualStyles.named}>{label}</span>;
  return <Occurrence {...props} presentation={{
    ref: props.subject, label, identity, href, item: null, primary,
    highlightId: resource?.kind === "highlight" ? parsed.id : null,
    status: <>
      {read.error ? <FeedbackNotice content={{tone: "Warning", title: "couldn’t read this on this device"}}
        announcement="Polite" actions={[{label: "retry", onClick: read.retry}]}/> : null}
      {/* a note's own editor shows its failed commit; pages and highlights show theirs here. */}
      {resource?.kind !== "note" && saving.error !== null && saving.error_refs.includes(props.subject) ?
        <FeedbackNotice content={{tone: "Warning", title: "couldn’t save on this device", message: "keep this page open. retry saving."}}
          announcement="Assertive" actions={[{label: "retry saving", onClick: () => void writing?.retry().catch(() => undefined)}]}/> : null}
    </>,
  }}/>;
}

function Occurrence({presentation, occurrenceKey, incoming, connection, representedEdgeIds = EMPTY_EDGE_IDS, onChanged,
  body, sourceContent, resourceDetails, nestedContent, details, placement, rootProps, rowRef,
  historical = false, editable = true, writing: writingRow = false, childrenAvailable, onSelectBlock, annotationFocusRequest = null, onAnnotationClose, ...props}: Shared & {presentation: Presentation}) {
  const {ref, label, identity, href, item, highlightId} = presentation;
  const runtime = usePaneRuntime();
  const writing = useWritingRuntime();
  const outline = useContext(ResourceOutlineContext);
  const branch = useContext(ResourceBranch);
  const commandDisabledReason = props.commandDisabledReason;
  const disclosureDisabled = outline?.viewLocked ?? false;
  const enteringEdgeId = incoming?.kind === "link" ? incoming.linkId : incoming?.kind === "edge" ? incoming.edge_id : null;
  const projection = classifyOutlineOccurrence({branch, targetRef: ref, edgeId: enteringEdgeId});
  const terminal = projection.kind === "reference";
  const childrenBranch = useMemo(() => enterOutlineOccurrence({branch, ref, target: {kind: "occurrence", key: occurrenceKey},
    edgeIds: [...representedEdgeIds, ...(enteringEdgeId === null ? [] : [enteringEdgeId])]}),
    [branch, ref, occurrenceKey, representedEdgeIds, enteringEdgeId]);
  const canExpand = !writingRow || childrenAvailable === true;
  // A highlight opens on its attached notes until someone folds it.
  const [localOpen, setLocalOpen] = useState<boolean | null>(null);
  const open = projection.kind === "resource" &&
    (placement?.expanded ?? outline?.view.folds.get(occurrenceKey) ?? localOpen ?? highlightId !== null);
  const [noteRequest, setNoteRequest] = useState(0);
  const childrenSection = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failure, setFailure] = useState<{content: FeedbackContent; action: FeedbackAction | null} | null>(null);
  const element = useRef<HTMLLIElement | null>(null);
  const attachRow = useCallback((node: HTMLLIElement | null) => {
    element.current = node;
    if (typeof rowRef === "function") rowRef(node); else if (rowRef) rowRef.current = node;
  }, [rowRef]);
  const arrow = useRef<HTMLButtonElement | null>(null);
  const attachDisclosure = useCallback((node: HTMLButtonElement | null) => {
    if (node === null && arrow.current === document.activeElement)
      element.current?.querySelector<HTMLElement>("[data-outline-bullet]")?.focus({preventScroll: true});
    arrow.current = node;
  }, []);
  const childrenId = useId();
  const removal = incoming?.kind === "edge" && writing !== null && !historical ? factRemoval(incoming, writing) : null;
  function toggle() {
    if (disclosureDisabled) return;
    if (open && element.current?.contains(document.activeElement)) arrow.current?.focus({preventScroll: true});
    if (placement) placement.toggle(); else if (outline) outline.toggle(occurrenceKey, !open); else setLocalOpen(!open);
  }
  // `add note` and an annotation request open the children and focus their own composer,
  // the one place a new attached note is written.
  const latest = useRef({open: () => {}, onAnnotationClose});
  latest.current = {open: () => { if (!open) toggle(); }, onAnnotationClose};
  const focusToken = `${annotationFocusRequest ?? ""}:${noteRequest}`;
  useEffect(() => {
    if (focusToken === ":0") return;
    latest.current.open();
    let frames = 0;
    let handle = requestAnimationFrame(function attempt() {
      const target = childrenSection.current?.querySelector<HTMLElement>(
        `[data-composer-destination="${CSS.escape(ref)}"] [contenteditable="true"]`);
      // Found or given up, the request is consumed so a later remount does not replay it.
      if (target) target.focus();
      if (target || ++frames >= 30) latest.current.onAnnotationClose?.();
      else handle = requestAnimationFrame(attempt);
    });
    return () => cancelAnimationFrame(handle);
  }, [focusToken, ref]);
  /** One server-fact removal; its failure stays beside the row with the owner's retry. */
  async function mutate(attempt: () => Promise<unknown>) {
    if (busyRef.current || commandDisabledReason) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    const row = element.current;
    const fallback = row?.closest("[data-outline-scope]")?.querySelector<HTMLElement>('ul[tabindex="-1"]');
    // A nested fact may retire its whole ancestor once its list refreshes.
    const neighbours = fallback && row?.parentElement !== fallback ? [fallback]
      : [row?.nextElementSibling, row?.previousElementSibling, row?.parentElement?.closest("li")].flatMap(node => node
        ? [node.querySelector<HTMLElement>("[data-row-focusable]:not(:disabled)") ?? (node as HTMLElement)] : []);
    if (fallback && !neighbours.includes(fallback)) neighbours.push(fallback);
    let ownsFocus = true;
    const release = () => { ownsFocus = false; };
    document.addEventListener("pointerdown", release, true);
    document.addEventListener("keydown", release, true);
    try {
      await attempt();
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        const content = connectionMutationErrorMessage(error);
        const changed = isApiError(error) && error.code === "E_CONTEXT_CHANGED";
        setFailure({content, action: changed ? {label: "refresh context", onClick: () => { setFailure(null); onChanged?.(); }}
          : {label: "retry", onClick: () => void mutate(attempt)}});
      }
      return;
    } finally {
      document.removeEventListener("pointerdown", release, true);
      document.removeEventListener("keydown", release, true);
      busyRef.current = false;
      setBusy(false);
    }
    const mayRestoreFocus = ownsFocus && (row?.contains(document.activeElement) || document.activeElement === document.body);
    onChanged?.();
    if (mayRestoreFocus && (row?.contains(document.activeElement) || document.activeElement === document.body))
      neighbours.find(node => node.isConnected)?.focus({preventScroll: true});
  }
  const commands: ActionDescriptor[] = [];
  if (onSelectBlock) commands.push({kind: "command", id: "Outline.SelectBlock", label: "select block",
    restoreFocusOnClose: false, onSelect: onSelectBlock});
  if (incoming?.kind === "link" && !historical) commands.push({kind: "command", id: "Resource.Relation.unlink",
    label: `unlink from ${incoming.parentLabel}`, restoreFocusOnClose: false, onSelect: () => incoming.unlink()});
  if (removal) commands.push({kind: "command", id: `Resource.Relation.${removal.id}`, label: removal.label,
    disabled: busy, disabledReason: busy ? "removal is pending" : undefined,
    restoreFocusOnClose: false, onSelect: () => void mutate(removal.run)});
  const made = incoming?.kind === "edge" ? incoming.creation : null;
  if (made) commands.push({kind: "link", id: "Resource.Creation", label: "view creation",
    href: made.conversation_id && made.message_id
      ? `/conversations/${made.conversation_id}?message=${made.message_id}`
      : `/settings/account?generation_id=${made.generation_id}&tool_call_id=${made.tool_call_id}#assistant-writes`});
  const bullet = (context: Partial<ActionMenuContextAnchorProps>) => href ? <a
    {...context} data-outline-bullet="true" className={cx(styles.control, styles.bullet)} href={href}
    aria-label={`open ${identity}: ${label}`} data-workspace-rich-target="true" data-row-focusable="true"
    onClick={event => activateTargetLink({event, runtime, target: {href, labelHint: label}})}
    onKeyDown={event => {context.onKeyDown?.(event); if (!event.defaultPrevented)
      activateTargetLink({event, runtime, target: {href, labelHint: label}});}}>•</a>
    : <button {...context} type="button" disabled={commands.length === 0} data-outline-bullet="true"
      className={cx(styles.control, styles.bullet)} aria-label={`actions for unavailable ${label}`} data-row-focusable="true">•</button>;
  const disclosure = terminal ? <button ref={attachDisclosure} type="button" className={styles.control}
    disabled={disclosureDisabled} aria-label={`show earlier occurrence of ${label}`}
    onClick={() => outline?.reveal(projection.target)} data-row-focusable="true"><CornerLeftUp size={14}/></button>
    : canExpand || open ? <button ref={attachDisclosure} type="button" className={styles.control}
      aria-label={`${open ? "collapse" : "expand"} linked resources for ${label}`} aria-expanded={open}
      aria-controls={open ? childrenId : undefined} disabled={item?.missing === true || disclosureDisabled}
      onClick={toggle} data-row-focusable="true"><ChevronRight size={14} className={styles.arrow} data-open={open || undefined}/></button>
    : null;
  if (projection.kind === "omit") return null;
  return <ResourceBranch value={childrenBranch}>
    <li {...rootProps} ref={attachRow} className={cx(styles.row, rootProps?.className)}
      tabIndex={rootProps?.tabIndex ?? 0} aria-label={rootProps?.["aria-label"] ?? `outline item: ${label}`}
      data-outline-occurrence={occurrenceKey} data-resource-ref={ref} data-writing={writingRow || undefined}>
      <div className={styles.head}>
        {!writingRow ? disclosure : null}
        {commands.length || writingRow ? <ContextualActionMenu title={label} subjectKey={`relationship:${occurrenceKey}`}
          sections={[{id: "Occurrence", actions: commands}]} commandDisabledReason={commandDisabledReason}
          label={`relationship actions for ${label}`} renderContextAnchor={bullet}/> : bullet({})}
        <div className={styles.content}>
          {body ?? presentation.primary}
          {sourceContent}
          {presentation.status}
          {highlightId && editable && !historical && !terminal && !open ?
            <Button className={styles.textButton} onClick={() => setNoteRequest(serial => serial + 1)}>add note</Button> : null}
          {resourceDetails}
          {connection?.snapshot?.rationale ? <div className={styles.details}><MachineText variant="inline" origin={{label: "librarian"}}>
            {connection.snapshot.rationale}</MachineText></div> : null}
          {details}
          {busy ? <FeedbackStatus content={{tone: "Neutral", title: "removing…"}} announcement="None"/> : null}
          {failure ? <FeedbackNotice content={failure.content} announcement="Assertive"
            actions={failure.action ? [failure.action] : undefined}/> : null}
        </div>
        {writingRow ? disclosure : <div className={styles.actions}><ContextualActionMenu omitResourceActions={props.omitResourceActions}
          title={label} subjectKey={occurrenceKey} resourceRef={assumeCanonicalResourceRef(item?.action_ref ?? ref)}
          displayedActivation={item?.activation} showSourceSubject={item !== null && item.action_ref !== item.ref}
          commandDisabledReason={commandDisabledReason} sections={[]} label={`more actions for ${label}`}/></div>}
      </div>
      {nestedContent || open ? <div className={styles.children} data-outline-children="true">{nestedContent}{open ?
        <section ref={childrenSection} id={childrenId} aria-label="linked resources">{placement?.children ??
          (writingRow ? <LocalOutline rootRef={ref} occurrencePrefix={occurrenceKey} ancestors={[...childrenBranch.ancestors.keys()]}/>
            : <Children ownerRef={ref} occurrenceKey={occurrenceKey} ancestors={[...childrenBranch.ancestors.keys()]}/>)}</section> : null}</div> : null}
    </li>
  </ResourceBranch>;
}

/** An expanded occurrence: its local links, then its separately failable server facts. */
function Children({ownerRef, occurrenceKey, ancestors}: {ownerRef: string; occurrenceKey: string; ancestors: readonly string[]}) {
  const remote = useRemoteConnections(ownerRef, occurrenceKey, useChangeStamp("Metadata"));
  return <>
    <LocalOutline rootRef={ownerRef} ancestors={ancestors} occurrencePrefix={occurrenceKey}/>
    <RemoteConnections ownerRef={ownerRef} occurrencePrefix={occurrenceKey} list={remote}
      onChanged={() => void remote.refetch().catch(() => undefined)}/>
  </>;
}
