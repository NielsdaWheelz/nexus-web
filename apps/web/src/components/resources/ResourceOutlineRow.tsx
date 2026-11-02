"use client";

// One occurrence of a resource in an outline branch. Historical items render their
// supplied evidence; ordinary authored refs render from the local store. Other
// refs render their server item; by ref they show the local source stub's literal
// label until it arrives.
// The occurrence owns only its relationship menu (its outline's unlink, server-fact
// removal); structure keys, selection and ordering belong to the outline's rootProps.
// Rows also disclose server facts.
// Local occurrence actions never wait for a remote resource menu.
import {useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode, type Ref} from "react";
import {ChevronRight, CornerLeftUp, History, Unlink} from "lucide-react";
import MachineText from "@/components/ui/MachineText";
import {FeedbackFailure, useFeedbackOccurrence, type FeedbackAction, type FeedbackContent} from "@/components/feedback/Feedback";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import BoundPageTitleEditor from "@/components/notes/BoundPageTitleEditor";
import NoteBodyPreview from "@/components/notes/NoteBodyPreview";
import {parseBody} from "@nexus/authored/body";
import {selectedExcerpt, type ExcerptView} from "@nexus/authored/excerpt";
import LocalOutline from "@/components/notes/LocalOutline";
import type {ActionMenuContextAnchorProps} from "@/components/ui/ActionMenu";
import {useChangeStamp} from "@/lib/api/changes";
import {useIndexRowWindow} from "@/lib/collections/indexRowWindow";
import {isApiError} from "@/lib/api/client";
import {assertNever} from "@/lib/assertNever";
import {usePaneFreeServerValue} from "@/lib/api/serverState";
import type {Schema} from "@/lib/api/wire";
import {handleUnauthenticatedApiError} from "@/lib/auth/UnauthenticatedApiBoundary";
import {useResolvedResourceItem} from "@/lib/media/mediaSummary";
import {useAuthoredQuery, useWritingRuntime} from "@/lib/notes/hooks";
import type {WritingRuntime} from "@/lib/notes/runtime";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import { paneForkLink } from "@/lib/panes/paneForkLink";
import { useTouchCapable } from "@/lib/renderEnvironment/provider";
import {activateTargetLink} from "@/lib/panes/targetLinkActivation";
import {connectionMutationErrorMessage, mutateConnection, type ConnectionMutation, type ConnectionOut} from "@/lib/resourceGraph/links";
import {parseResourceRef, resourceTypeLabel} from "@/lib/resourceGraph/resourceRef";
import {resolveResourceItem} from "@/lib/resources/items";
import {localResourceHref, localResourceLabel} from "@/lib/resources/localResource";
import {resourceMetadata} from "@/lib/resources/metadata";
import {classifyOutlineOccurrence, enterOutlineOccurrence} from "@/lib/resources/outlineProjection";
import {assumeCanonicalResourceRef} from "@/lib/sharing/targets";
import type {ActionDescriptor} from "@/lib/ui/actionDescriptor";
import {workspaceTargetActivationIntent, type TargetActivationEvent} from "@/lib/ui/targetActivation";
import {cx} from "@/lib/ui/cx";
import RemoteConnections, {useRemoteConnections} from "@/components/connections/RemoteConnections";
import ContextualActionMenu, {type ContextActionSection} from "./ContextualActionMenu";
import { FullResourceBody } from "./ExcerptDisclosure";
import { authoredItem } from "@/lib/notes/presentation";
import ReaderExcerpt from "./ReaderExcerpt";
import {ResourceTypeIcon} from "./ResourceType";
import ResourceMetadata from "./ResourceMetadata";
import {ResourceBranch, ResourceOutlineContext} from "./ResourceOutlineList";
import styles from "./ResourceOutline.module.css";
import factualStyles from "./ResourceContent.module.css";

type Item = Schema<"ResourceItemOut">;
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
  incoming: Incoming;
  connection?: ConnectionOut;
  occurrenceLabel?: string;
  onChanged?: () => void;
  /** The host shows this passage already: the row is its quote, with no provenance. */
  inSource?: boolean;
  /** Occurrence verbs for the right menu; `omitResourceActions` drops any resource verb they replace. */
  rowActions?: ContextActionSection["actions"];
  sourceContent?: ReactNode;
  resourceDetails?: ReactNode;
  details?: ReactNode;
  omitResourceActions?: readonly string[];
  rootProps?: HTMLAttributes<HTMLElement> & {"data-active"?: boolean; "data-selected"?: boolean};
  rowRef?: Ref<HTMLLIElement>;
  authoredByViewer?: boolean;
  historical?: boolean;
  readingRef?: string | null;
  /** Local note editing; terminal and historical occurrences never edit. */
  editable?: boolean;
  /** The owning flat editor settles or refuses removal of its disclosed fields. */
  beforeCollapse?: () => Promise<boolean>;
  annotationFocusRequest?: number | null;
  onAnnotationClose?: () => void;
};
type Props = Shared & (
  | {item: Item; resourceRef?: never; historical?: boolean}
  | {resourceRef: string; item?: never; historical?: false}
);
/** What the shared occurrence chrome shows for one resource. */
interface Presentation {
  ref: string;
  label: string;
  href: string | null;
  primary: ReactNode;
  item: Item | null;
  /** A local highlight's id; its annotation body remains distinct from related resources. */
  highlightId: string | null;
  status: ReactNode;
}

const AUTHORED = /^(note_block|page|highlight|passage_anchor):/u;
/** A server fact's removal, when its owner offers one; local links unlink through their outline. */
function factRemoval(incoming: Extract<Incoming, {kind: "edge"}>, writing: WritingRuntime): {id: string; label: string; run(): Promise<unknown>} | null {
  const mutation = incoming.mutation;
  if (mutation === null) return null;
  switch (mutation.kind) {
    case "detach_context": return {id: mutation.kind, label: "Remove from future context", run: () => mutateConnection(writing, mutation)};
    case "remove_fact": return {id: mutation.kind, label: "Remove suggested connection",
      run: () => mutateConnection(writing, {kind: "remove_fact", edge_id: incoming.edge_id})};
    default: return assertNever(mutation);
  }
}

export default function ResourceOutlineRow({item, resourceRef, ...shared}: Props) {
  shared.readingRef = item?.preview.body.kind === "passage" ? item.preview.body.reading_ref : shared.readingRef ?? null;
  if(item!==undefined&&shared.historical)return <RemoteRow {...shared} item={item}/>;
  if(item!==undefined)return item.authored_by_viewer&&AUTHORED.test(item.ref)?<LocalRow {...shared} authoredByViewer subject={item.ref}/>:<RemoteRow {...shared} item={item}/>;
  return <LocalRow {...shared} subject={resourceRef!}/>;
}

function LocalRow(props:Shared&{subject:string}){
  const read=useAuthoredQuery(props.readingRef && /^(highlight|passage_anchor):/u.test(props.subject) ? {kind:"excerpt",ref:props.subject,reading_ref:props.readingRef} : {kind:"resource",ref:props.subject});
  const resource=read.data?.rows[0]?.resource;
  const [ownedRef,setOwnedRef]=useState<string|null>(null);
  useLayoutEffect(()=>{if(resource?.authored_by_viewer)setOwnedRef(props.subject);},[resource?.authored_by_viewer,props.subject]);
  if(props.authoredByViewer||resource?.authored_by_viewer||ownedRef===props.subject)return <AuthoredRow {...props} read={read}/>;
  if(read.data)return <ReferenceRow {...props}/>;
  return <Occurrence {...props} presentation={{ref:props.subject,label:props.subject,href:null,item:null,highlightId:null,primary:<span data-resource-primary>{props.subject}</span>,status:<AuthoredReadFailure {...read} title="couldn’t refresh this resource"/>}}/>;
}

/** The row's one link to its resource; a null href renders its children alone. */
function PrimaryLink({href, label, quote = false, children}: {href: string | null; label: string; quote?: boolean; children: ReactNode}) {
  const runtime = usePaneRuntime();
  if (href === null) return children;
  const activate = (event: TargetActivationEvent) => activateTargetLink({event, runtime, target: {href, labelHint: label}});
  return <a className={cx(styles.primaryLink, quote && styles.quote)} href={href} draggable={quote ? false : undefined}
    aria-label={`open ${label}`} data-workspace-rich-target="true"
    onClick={event => {
      const intent = workspaceTargetActivationIntent(event);
      // Plain Enter arrives as a click with no pointer; only a pointer's plain click can end a drag.
      if (quote && intent.kind === "Open" && intent.intent === "default" && event.nativeEvent instanceof PointerEvent &&
        event.nativeEvent.pointerType !== "" && window.getSelection()?.isCollapsed === false) event.preventDefault();
      else activate(event);
    }}
    onKeyDown={activate}>{children}</a>;
}

function SelectedQuote({excerpt, color, href, label}: {excerpt: ExcerptView; color: string | null; href: string | null; label: string}) {
  return <PrimaryLink href={href} label={label} quote><ReaderExcerpt excerpt={selectedExcerpt(excerpt)} color={color}/></PrimaryLink>;
}

/** A server item's presentation; shared so a by-ref row keeps one Occurrence while its item arrives. */
function remotePresentation(item: Item, props: Shared): Presentation {
  const metadata = resourceMetadata({item, occurrenceLabel: props.occurrenceLabel});
  const activation = item.activation, body = item.preview.body;
  const unavailable = activation.unavailable_reason === "location_unavailable" ? "quoted location unavailable"
    : activation.unavailable_reason === "source_unavailable" ? "source unavailable" : null;
  const content = <FullResourceBody item={item} historical={props.historical}/>;
  const quote = props.inSource && body.kind === "passage" ? body : null;
  const title = item.preview.source?.title?.trim();
  const parts = metadata.parts.filter(({key}) => quote ? key !== "source" && key !== "location"
    : key !== "source" || body.kind !== "passage" || activation.href === null || !title);
  return {
    ref: item.ref, label: item.label, href: activation.href, item, highlightId: null,
    primary: quote ? quote.excerpt.kind === "content"
      ? <SelectedQuote excerpt={quote.excerpt} color={quote.color} href={activation.href} label={item.label}/> : content
      : <div className={styles.reference}>
        {body.kind !== "passage" || activation.href ? <PrimaryLink href={activation.href} label={item.label}>
          {body.kind === "passage" ? title || item.label : content}</PrimaryLink> : null}
        {body.kind === "passage" ? content : null}
        {metadata.bibliography.length ? <span className={factualStyles.bibliography}><span className={styles.separator}> · </span>
          <ResourceMetadata parts={metadata.bibliography} linkSource={false}/></span> : null}
      </div>,
    status: <>
      {parts.length ? <div className={styles.metadata}><ResourceMetadata parts={parts} linkSource/></div> : null}
      {unavailable ? <p className={styles.status}>{unavailable}</p> : null}
    </>,
  };
}

function RemoteRow(props: Shared & {item: Item}) {
  const item = useResolvedResourceItem(props.item, props.historical);
  return <Occurrence {...props} presentation={remotePresentation(item, props)}/>;
}

/** A non-authored ref: the stub's literal capture until the server item arrives, in one Occurrence. */
function ReferenceRow(props: Shared & {subject: string}) {
  const remote = usePaneFreeServerValue<Item>({key: `/resource-items/${props.subject}`, stale: useChangeStamp("Metadata"),
    load: signal => resolveResourceItem(props.subject, signal)});
  const local = useAuthoredQuery(remote.status === "ready" ? null : {kind: "resource", ref: props.subject});
  const stub = local.data?.rows[0]?.resource ?? null;
  // Absent locally and still being read remotely is not yet "unavailable": show the literal ref.
  const settled = remote.status === "failed";
  const label = stub ? localResourceLabel(stub) : settled ? "unavailable resource" : props.subject;
  if(remote.status==="ready"&&remote.data.authored_by_viewer&&AUTHORED.test(props.subject))return <LocalRow {...props} authoredByViewer/>;
  return <Occurrence {...props} presentation={remote.status === "ready" ? {...remotePresentation(remote.data, props), ref: props.subject} : {
    ref: props.subject, label,
    href: stub ? localResourceHref(stub) : null, item: null, highlightId: null,
    primary: <span data-resource-primary className={factualStyles.named}>{label}</span>,
    status: local.error ? <AuthoredReadFailure {...local} title="couldn’t refresh this resource"/>
      : !stub && local.data && settled ? <p className={styles.status}>not available on this device</p> : null,
  }}/>;
}

function AuthoredRow({read,...props}: Shared & {subject: string; read: ReturnType<typeof useAuthoredQuery>}) {
  const resource = read.data?.rows[0]?.resource ?? null;
  const source = useAuthoredQuery(!props.inSource && resource?.kind === "highlight" && resource.source_ref ? {kind: "resource", ref: resource.source_ref} : null);
  const branch = useContext(ResourceBranch);
  const parsed = parseResourceRef(props.subject)!;
  const label = resource ? localResourceLabel(resource) : parsed.scheme === "note_block" ? "unavailable note"
    : parsed.scheme === "page" ? "unavailable page" : "unavailable highlight";
  const terminal = classifyOutlineOccurrence({branch, targetRef: props.subject, edgeId: null}).kind === "reference";
  const editable = (props.editable ?? true) && !props.historical && !terminal;
  const href = resource ? localResourceHref(resource, { activationRef: props.readingRef ?? null }) : null;
  const sourceLabel = source.data?.rows[0]?.resource;
  const primary = !resource ? <span className={factualStyles.quiet}>{read.data ? "no longer available on this device" : ""}</span>
    : resource.kind === "note" ? editable ? <BoundNoteEditor noteRef={props.subject} label={`edit note: ${label}`} editable/>
      : <NoteBodyPreview body={parseBody(resource.body_pm_json)}/>
    : resource.kind === "page" ? editable ? <BoundPageTitleEditor pageRef={props.subject} label={`edit page title: ${label}`} editable
      placeholder={resource.local_date ?? "untitled page"}/> : <span data-resource-primary className={factualStyles.named}>{label}</span>
    : resource.excerpt !== null ? <div className={props.inSource ? styles.quotation : styles.reference}>
      {props.inSource ? <SelectedQuote excerpt={resource.excerpt} color={resource.color} href={href} label={label}/> : <>
        {sourceLabel || href ? <PrimaryLink href={href} label={label}>{sourceLabel ? localResourceLabel(sourceLabel) : "highlight"}</PrimaryLink> : null}
        <FullResourceBody item={authoredItem(resource, props.readingRef ?? null)} />
      </>}
      <HighlightAnnotation highlightRef={props.subject} occurrenceKey={props.occurrenceKey} editable={editable} offerBlank={!props.inSource} focusRequest={props.annotationFocusRequest} onFocused={props.onAnnotationClose}/>
    </div>
    : <span data-resource-primary className={factualStyles.named}>{label}</span>;
  return <Occurrence {...props} presentation={{
    ref: props.subject, label, href, item: null, primary,
    highlightId: resource?.kind === "highlight" ? parsed.id : null,
    status: <>
      <AuthoredReadFailure {...read} title="couldn’t refresh this resource"/>
    </>,
  }}/>;
}

function Occurrence({presentation, occurrenceKey, incoming, connection, onChanged,
  sourceContent, resourceDetails, details, rootProps, rowRef,
  historical = false, editable: _editable = true, annotationFocusRequest: _annotationFocusRequest = null, onAnnotationClose: _onAnnotationClose, rowActions, ...props}: Shared & {presentation: Presentation}) {
  const {ref, label, href, item, highlightId} = presentation;
  const parsed = parseResourceRef(ref);
  // justify-defect: every occurrence names a canonical displayed resource.
  if (parsed === null) throw new Error(`invalid canonical resource ref: ${ref}`);
  const identity = resourceTypeLabel(parsed.scheme).toLowerCase();
  const marker = parsed.scheme === "note_block" ? "•" : <ResourceTypeIcon scheme={parsed.scheme}/>;
  const runtime = usePaneRuntime();
  const touch = useTouchCapable();
  const writing = useWritingRuntime();
  const outline = useContext(ResourceOutlineContext);
  const branch = useContext(ResourceBranch);
  const disclosureDisabled = outline?.viewLocked ?? false;
  const enteringEdgeId = incoming?.kind === "link" ? incoming.linkId : incoming?.kind === "edge" ? incoming.edge_id : null;
  const projection = classifyOutlineOccurrence({branch, targetRef: ref, edgeId: enteringEdgeId});
  const terminal = projection.kind === "reference";
  const childrenBranch = useMemo(() => enterOutlineOccurrence({branch, ref, target: {kind: "occurrence", key: occurrenceKey},
    edgeIds: enteringEdgeId === null ? [] : [enteringEdgeId]}),
    [branch, ref, occurrenceKey, enteringEdgeId]);
  const [localOpen, setLocalOpen] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failure, setFailure] = useState<{content: FeedbackContent; action: FeedbackAction | null} | null>(null);
  const rowWindow = useIndexRowWindow();
  const unsettled = busy || failure !== null;
  useLayoutEffect(() => unsettled ? rowWindow?.pin() : undefined, [rowWindow, unsettled]);
  const failureOccurrence = useFeedbackOccurrence(failure !== null, occurrenceKey);
  const element = useRef<HTMLLIElement | null>(null);
  const attachRow = useCallback((node: HTMLLIElement | null) => {
    element.current = node;
    if (typeof rowRef === "function") rowRef(node); else if (rowRef) rowRef.current = node;
  }, [rowRef]);
  const arrow = useRef<HTMLButtonElement | null>(null);
  const lostArrowFocus=useRef(false);
  const attachDisclosure=useCallback((node:HTMLButtonElement|null)=>{
    if(node===null&&arrow.current===document.activeElement)lostArrowFocus.current=true;
    arrow.current=node;
  },[]);
  const excludedEdgeIds=useMemo(()=>[...childrenBranch.traversedEdgeIds].sort(),[childrenBranch]);
  const aliasMeaning=item?.preview.body.kind==="passage"&&!ref.startsWith("passage_anchor:")?[item.action_ref,item.preview.source?.ref??null,item.preview.body.excerpt,item.preview.body.capture_revision,item.activation]:null;
  const descriptor=projection.kind==="resource"&&item?.missing!==true?{
    resource_ref:ref,excluded_edge_ids:excludedEdgeIds,
    identity:JSON.stringify([ref,excludedEdgeIds,aliasMeaning]),
  }:null;
  const latestDescriptor=useRef(descriptor);latestDescriptor.current=descriptor;
  const descriptorIdentity=descriptor?.identity??null;
  const registerChildren=outline?.registerChildren;
  useLayoutEffect(()=>{
    if(registerChildren&&latestDescriptor.current!==null)return registerChildren(occurrenceKey,latestDescriptor.current);
  },[registerChildren,occurrenceKey,descriptorIdentity]);
  const proof=outline?.childAvailability.get(occurrenceKey);
  const compatible=descriptor!==null&&proof?.identity===descriptor.identity?proof:null;
  const hasChildren=compatible?.value===true;
  const hasControl=terminal||hasChildren;
  // A highlight opens its related resources until someone folds it. One the host already
  // shows latches open at its first child, so removing the last keeps its history and focus.
  if (props.inSource && hasChildren && localOpen === null) setLocalOpen(true);
  const open = projection.kind === "resource" &&
    (outline?.view.folds.get(occurrenceKey) ?? localOpen ?? (highlightId !== null && !props.inSource));
  useLayoutEffect(()=>{
    if(!hasControl&&lostArrowFocus.current){const row=element.current,bullet=row?.querySelector<HTMLElement>("[data-outline-bullet]");(bullet&&!bullet.matches(":disabled")?bullet:row)?.focus({preventScroll:true});}
    lostArrowFocus.current=false;
  },[hasControl]);
  const childrenId = useId();
  const removal = incoming?.kind === "edge" && writing !== null && !historical ? factRemoval(incoming, writing) : null;
  async function toggle() {
    if (disclosureDisabled) return;
    if (open && props.beforeCollapse && !await props.beforeCollapse()) return;
    if (open && element.current?.contains(document.activeElement)) arrow.current?.focus({preventScroll: true});
    if (outline) outline.toggle(occurrenceKey, !open); else setLocalOpen(!open);
  }
  /** One server-fact removal; its failure stays beside the row with the owner's retry. */
  async function mutate(attempt: () => Promise<unknown>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
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
    setFailure(null);
    onChanged?.();
    outline?.refreshChildren();
    if (mayRestoreFocus && (row?.contains(document.activeElement) || document.activeElement === document.body))
      neighbours.find(node => node.isConnected)?.focus({preventScroll: true});
  }
  const commands: ActionDescriptor[] = [];
  if (incoming?.kind === "link" && !historical) commands.push({kind: "command", id: "Resource.Relation.unlink",
    label: `Unlink from ${incoming.parentLabel}`, icon: <Unlink size={16} aria-hidden="true" />, restoreFocusOnClose: false, onSelect: () => incoming.unlink()});
  if (removal) commands.push({kind: "command", id: `Resource.Relation.${removal.id}`, label: removal.label, icon: <Unlink size={16} aria-hidden="true" />,
    disabled: busy, disabledReason: busy ? "removal is pending" : undefined,
    restoreFocusOnClose: false, onSelect: () => void mutate(removal.run)});
  const made = incoming?.kind === "edge" ? incoming.creation : null;
  if (made) commands.push({kind: "link", id: "Resource.Creation", label: "View creation", icon: <History size={16} aria-hidden="true" />,
    href: made.conversation_id && made.message_id
      ? `/conversations/${made.conversation_id}?message=${made.message_id}`
      : `/settings/account?generation_id=${made.generation_id}&tool_call_id=${made.tool_call_id}#assistant-writes`});
  const bullet = (context: Partial<ActionMenuContextAnchorProps>) => href ? <a
    {...context} data-outline-bullet="true" className={cx(styles.control, styles.bullet)} href={href}
    aria-label={`open ${identity}: ${label}`} data-workspace-rich-target="true" data-row-focusable="true"
    onClick={event => activateTargetLink({event, runtime, target: {href, labelHint: label}})}
    onKeyDown={event => {context.onKeyDown?.(event); if (!event.defaultPrevented)
      activateTargetLink({event, runtime, target: {href, labelHint: label}});}}>{marker}</a>
    : <button {...context} type="button" disabled={commands.length === 0} data-outline-bullet="true"
      className={cx(styles.control, styles.bullet)} aria-label={`actions for ${identity}: ${label}`} data-row-focusable="true">{marker}</button>;
  const disclosure = terminal ? <button ref={attachDisclosure} type="button" className={styles.control}
    disabled={disclosureDisabled} aria-label={`show earlier occurrence of ${label}`}
    onClick={() => outline?.reveal(projection.target)} data-row-focusable="true"><CornerLeftUp size={14}/></button>
    : hasChildren ? <button ref={attachDisclosure} type="button" className={styles.control}
      aria-label={`${open ? "collapse" : "expand"} linked resources for ${label}`} aria-expanded={open}
      aria-controls={open ? childrenId : undefined} disabled={item?.missing === true || disclosureDisabled}
      onClick={toggle} data-row-focusable="true"><ChevronRight size={14} className={styles.arrow} data-open={open || undefined}/></button>
    : <span className={styles.spacer} aria-hidden="true"/>;
  if (projection.kind === "omit") return null;
  return <ResourceBranch value={childrenBranch}>
    <li {...rootProps} ref={attachRow} className={cx(styles.row, rootProps?.className)}
      tabIndex={rootProps?.tabIndex ?? 0} aria-label={rootProps?.["aria-label"] ?? `outline item: ${label}`}
      data-outline-occurrence={occurrenceKey} data-resource-ref={ref}>
      <div className={styles.head}>
        {disclosure}
        {commands.length ? <ContextualActionMenu navigation={null} title={label} subjectKey={`relationship:${occurrenceKey}`}
          sections={[{id: "Occurrence", actions: commands}]}
          label={`relationship actions for ${label}`} renderContextAnchor={bullet}/> : bullet({})}
        <div className={styles.content}>
          {presentation.primary}
          {sourceContent}
          {presentation.status}
          {resourceDetails}
          {connection?.snapshot?.rationale ? <div className={styles.details}><MachineText variant="inline" origin={{label: "librarian"}}>
            {connection.snapshot.rationale}</MachineText></div> : null}
          {details}
          {failure ? <FeedbackFailure scope="Local" occurrence={failureOccurrence} content={failure.content} announcement="Assertive"
            actions={failure.action ? [{...failure.action, busy}] : undefined}/> : null}
        </div>
        <div className={styles.actions}><ContextualActionMenu omitResourceActions={props.omitResourceActions}
          title={label} subjectKey={occurrenceKey} resourceRef={assumeCanonicalResourceRef(item?.action_ref ?? ref)}
          navigation={item === null ? null : {
            key: `${occurrenceKey}:${JSON.stringify(item.activation)}`,
            fork: touch && runtime && item.activation.kind === "route" && item.activation.href !== null
              ? paneForkLink({ runtime, target: { href: item.activation.href, labelHint: label }, disabledReason: null }) : null,
          }} showSourceSubject={item !== null && item.action_ref !== item.ref}
          sections={rowActions ? [{id: "Occurrence", actions: rowActions}] : []} label={`more actions for ${label}`}/></div>
      </div>
      {open ? <div className={styles.children} data-outline-children="true"><section id={childrenId} aria-label="linked resources">
        <Children ownerRef={ref} localOwnerRef={compatible?.local_ref??null} occurrenceKey={occurrenceKey} ancestors={[...childrenBranch.ancestors.keys()]}/></section></div> : null}
    </li>
  </ResourceBranch>;
}

/** An expanded occurrence: its local links, then its separately failable server facts. */
function Children({ownerRef, localOwnerRef, occurrenceKey, ancestors}: {ownerRef: string; localOwnerRef:string|null; occurrenceKey: string; ancestors: readonly string[]}) {
  const branch=useContext(ResourceBranch);
  const remote = useRemoteConnections(ownerRef, occurrenceKey, useChangeStamp("Metadata"));
  return <>
    <LocalOutline rootRef={ownerRef} ancestors={ancestors} occurrencePrefix={occurrenceKey}/>
    {localOwnerRef&&localOwnerRef!==ownerRef?<ResourceBranch value={enterOutlineOccurrence({branch,ref:localOwnerRef,target:{kind:"occurrence",key:occurrenceKey},edgeIds:[]})}><LocalOutline rootRef={localOwnerRef} ancestors={[...ancestors,localOwnerRef]} occurrencePrefix={`${occurrenceKey}/owner`}/></ResourceBranch>:null}
    <RemoteConnections ownerRef={ownerRef} occurrencePrefix={occurrenceKey} list={remote}
      onChanged={() => void remote.refetch().catch(() => undefined)}/>
  </>;
}
