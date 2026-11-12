"use client";

// One occurrence of a resource in an outline branch. Historical items render their
// supplied evidence; ordinary authored refs render from the local store, or from a
// projection the host already holds. Other refs render their server item; by ref
// they show the local source stub's literal label until it arrives.
// The occurrence owns only its relationship menu (its outline's unlink, server-fact
// removal); structure keys, selection and ordering belong to the outline's rootProps.
// Rows also disclose server facts.
// Local occurrence actions never wait for a remote resource menu.
import {useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type HTMLAttributes, type ReactNode, type Ref} from "react";
import * as Icon from "@/lib/ui/icons";
import MachineText from "@/components/ui/MachineText";
import {Fact, Failed} from "@/components/feedback/Fact";
import AuthoredReadFailure from "@/components/notes/AuthoredReadFailure";
import HighlightAnnotation from "@/components/notes/HighlightAnnotation";
import BoundNoteEditor from "@/components/notes/BoundNoteEditor";
import BoundPageTitleEditor from "@/components/notes/BoundPageTitleEditor";
import NoteBodyPreview from "@/components/notes/NoteBodyPreview";
import {parseBody} from "@nexus/authored/body";
import type {ResourceProjection} from "@nexus/authored/types";
import {selectedExcerpt, type ExcerptView} from "@nexus/authored/excerpt";
import LocalOutline from "@/components/notes/LocalOutline";
import type {ActionMenuContextAnchorProps} from "@/components/ui/ActionMenu";
import {useChangeStamp} from "@/lib/api/changes";
import {useIndexRowWindow} from "@/lib/collections/indexRowWindow";
import {usePaneFreeServerValue} from "@/lib/api/serverState";
import type {Schema} from "@/lib/api/wire";
import {useResolvedResourceItem} from "@/lib/media/mediaSummary";
import {useAuthoredQuery, useWritingRuntime} from "@/lib/notes/hooks";
import {isAuthoredStorageFailure} from "@/lib/notes/runtime";
import type {OutlineAnnotationCapability, OutlineController} from "@/lib/notes/outlineController";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import { paneForkLink } from "@/lib/panes/paneForkLink";
import { useTouchCapable } from "@/lib/renderEnvironment/provider";
import {activateTargetLink} from "@/lib/panes/targetLinkActivation";
import {type ConnectionMutation, type ConnectionOut} from "@/lib/resourceGraph/links";
import {FactRemovalsContext, type FactRemovalCommand} from "@/lib/resourceGraph/useFactRemovals";
import {hasAuthoredContent, parseResourceRef} from "@/lib/resourceGraph/resourceRef";
import {resolveResourceItem} from "@/lib/resources/items";
import {localResourceHref, localResourceLabel} from "@/lib/resources/localResource";
import {resourceMetadata} from "@/lib/resources/metadata";
import {itemMediaKind, resourceType, resourceTypeName} from "@/lib/resources/type";
import {classifyOutlineOccurrence, enterOutlineOccurrence} from "@/lib/resources/outlineProjection";
import {assumeCanonicalResourceRef} from "@/lib/sharing/targets";
import type {ActionDescriptor} from "@/lib/ui/actionDescriptor";
import {workspaceTargetActivationIntent, type TargetActivationEvent} from "@/lib/ui/targetActivation";
import {cx} from "@/lib/ui/cx";
import RemoteConnections, {useRemoteConnections} from "@/components/connections/RemoteConnections";
import ContextualActionMenu, {type ContextActionSection} from "./ContextualActionMenu";
import { FullResourceBody } from "./ExcerptDisclosure";
import {PreparedResourcesContext} from "@/lib/resources/preparedResources";
import { authoredItem } from "@/lib/notes/presentation";
import ReaderExcerpt from "./ReaderExcerpt";
import {ResourceTypeIcon} from "./ResourceType";
import ResourceMetadata from "./ResourceMetadata";
import {outlineRowFocusTarget, ResourceBranch, ResourceOutlineContext} from "./ResourceOutlineList";
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
  /** The body of a containing outline row, which owns the leading column: this row's controls trail its content. */
  inRow?: boolean;
  /** Initial disclosure only; retained user choices take precedence. */
  defaultOpen?: boolean;
};
type Props = Shared & (
  | {item: Item; resourceRef?: never; resource?: never; historical?: boolean}
  | {resourceRef: string; item?: never; resource?: never; historical?: false}
  | {resource: ResourceProjection; item?: never; resourceRef?: never; historical?: false}
);
/** What the shared occurrence chrome shows for one resource. */
interface Presentation {
  ref: string;
  /** null: nothing names it yet, so the row names its type, never its raw ref. */
  label: string | null;
  href: string | null;
  primary: ReactNode;
  item: Item | null;
  /** A local highlight's id; its annotation body remains distinct from related resources. */
  highlightId: string | null;
  status: ReactNode;
  annotation?: {resource: ResourceProjection; editable: boolean};
}

/** A server fact's removal, when its owner offers one; local links unlink through their outline. */
function factRemoval(incoming: Extract<Incoming, {kind: "edge"}>): {id: string; label: string; command: FactRemovalCommand} | null {
  const mutation = incoming.mutation;
  if (mutation === null) return null;
  return {id: mutation.kind, label: "remove suggested connection",
    command: {kind: "remove_fact", edge_id: incoming.edge_id}};
}

export default function ResourceOutlineRow({item, resourceRef, resource, ...shared}: Props) {
  shared.readingRef = item?.preview.body.kind === "passage" ? item.preview.body.reading_ref : shared.readingRef ?? null;
  if(item!==undefined&&shared.historical)return <RemoteRow {...shared} item={item}/>;
  if(item!==undefined)return item.authored_by_viewer&&hasAuthoredContent(item.ref)?<LocalRow {...shared} authoredByViewer subject={item.ref}/>:<RemoteRow {...shared} item={item}/>;
  // a link's projection can be a source stub.
  if(resource!==undefined)return resource.authored_by_viewer?<AuthoredRow {...shared} subject={resource.ref} resource={resource} answered status={null}/>:<ReferenceRow {...shared} subject={resource.ref}/>;
  return <LocalRow {...shared} subject={resourceRef!}/>;
}

function LocalRow(props:Shared&{subject:string}){
  const read=useAuthoredQuery(props.readingRef && /^(highlight|passage_anchor):/u.test(props.subject) ? {kind:"excerpt",ref:props.subject,reading_ref:props.readingRef} : {kind:"resource",ref:props.subject});
  const resource=read.data?.rows[0]?.resource??null;
  const [ownedRef,setOwnedRef]=useState<string|null>(null);
  useLayoutEffect(()=>{if(resource?.authored_by_viewer)setOwnedRef(props.subject);},[resource?.authored_by_viewer,props.subject]);
  // A storage failure speaks only until the row has shown; a defect throws whenever it comes.
  if(read.error!==null&&!isAuthoredStorageFailure(read.error))throw read.error;
  const type=resourceTypeName(resourceType(parseResourceRef(props.subject)!.scheme,null));
  const status=read.data === null ? <AuthoredReadFailure {...read} noun={`this ${type}`}/> : null;
  if(props.authoredByViewer||resource?.authored_by_viewer||ownedRef===props.subject)return <AuthoredRow {...props} resource={resource} answered={read.data?.scope_available===true} status={status}/>;
  if(read.data)return <ReferenceRow {...props}/>;
  return <Occurrence {...props} presentation={{ref:props.subject,label:null,href:null,item:null,highlightId:null,primary:<span data-resource-primary className={styles.pending}/>,status}}/>;
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
        {metadata.bibliography.length ? <span className={factualStyles.bibliography}><span className={styles.separator} aria-hidden="true"> · </span>
          <ResourceMetadata parts={metadata.bibliography} linkSource/></span> : null}
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
  // The stub read is auxiliary: its storage failure says nothing, its defect throws.
  if (local.error !== null && !isAuthoredStorageFailure(local.error)) throw local.error;
  const stub = local.data?.rows[0]?.resource ?? null;
  // Absent locally and still being read remotely is not yet "unavailable": the row names its type, never its ref.
  const failed = remote.status === "failed";
  const label = stub ? localResourceLabel(stub) : failed ? "unavailable resource" : null;
  if(remote.status==="ready"&&remote.data.authored_by_viewer&&hasAuthoredContent(props.subject))return <LocalRow {...props} authoredByViewer/>;
  return <Occurrence {...props} presentation={remote.status === "ready" ? {...remotePresentation(remote.data, props), ref: props.subject} : {
    ref: props.subject, label,
    href: stub ? localResourceHref(stub) : null, item: null, highlightId: null,
    primary: label === null ? <span data-resource-primary className={styles.pending}/> : <span data-resource-primary className={factualStyles.named}>{label}</span>,
    status: remote.status === "failed" ? <Failed error={remote.error} noun="this item’s details" retry={{run: remote.refetch, busy: remote.retrying}}/> : null,
  }}/>;
}

/** `answered`: the host has proved absence, so a null resource is gone rather than pending. */
function AuthoredRow({resource, answered, status, ...props}: Shared & {subject: string; resource: ResourceProjection | null; answered: boolean; status: ReactNode}) {
  const prepared = useContext(PreparedResourcesContext);
  const sourceRef = !props.inSource && resource?.kind === "highlight" ? resource.source_ref : null;
  const heldSource = sourceRef !== null && (prepared?.has(sourceRef) ?? false);
  const source = useAuthoredQuery(sourceRef && !heldSource ? {kind: "resource", ref: sourceRef} : null);
  const branch = useContext(ResourceBranch);
  const parsed = parseResourceRef(props.subject)!;
  const type = resourceTypeName(resourceType(parsed.scheme, null));
  const label = resource ? localResourceLabel(resource) : type;
  const terminal = classifyOutlineOccurrence({branch, targetRef: props.subject, edgeId: null}).kind === "reference";
  const editable = (props.editable ?? true) && !props.historical && !terminal;
  const href = resource ? localResourceHref(resource, { activationRef: props.readingRef ?? null }) : null;
  const sourceLabel = heldSource ? prepared!.get(sourceRef!)?.resource : source.data?.rows[0]?.resource;
  const primary = !resource ? answered ? <Fact line={{fact: `this ${type} isn’t on this device.`}}/> : null
    : resource.kind === "note" ? editable ? <BoundNoteEditor noteRef={props.subject} label={`edit note: ${label}`} editable/>
      : <NoteBodyPreview body={parseBody(resource.body_pm_json)}/>
    : resource.kind === "page" ? editable ? <BoundPageTitleEditor pageRef={props.subject} label={`edit page title: ${label}`} editable
      placeholder={resource.local_date ?? "untitled page"}/> : <span data-resource-primary className={factualStyles.named}>{label}</span>
    : resource.excerpt !== null ? <div className={props.inSource ? styles.quotation : styles.reference}>
      {props.inSource ? <SelectedQuote excerpt={resource.excerpt} color={resource.color} href={href} label={label}/> : <>
        {sourceLabel || href ? <PrimaryLink href={href} label={label}>{sourceLabel ? localResourceLabel(sourceLabel) : "highlight"}</PrimaryLink> : null}
        <FullResourceBody item={authoredItem(resource, props.readingRef ?? null, href)} />
      </>}
    </div>
    : <span data-resource-primary className={factualStyles.named}>{label}</span>;
  return <Occurrence {...props} presentation={{
    ref: props.subject, label, href, item: null, primary,
    highlightId: resource?.kind === "highlight" ? parsed.id : null,
    ...(resource?.kind === "highlight" ? {annotation: {resource, editable}} : {}),
    status,
  }}/>;
}

function Occurrence({presentation, occurrenceKey, incoming, connection, onChanged,
  sourceContent, resourceDetails, details, rootProps, rowRef,
  historical = false, editable: _editable = true, annotationFocusRequest = null, onAnnotationClose, rowActions, inRow = false, ...props}: Shared & {presentation: Presentation}) {
  const {ref, href, item, highlightId} = presentation;
  const parsed = parseResourceRef(ref);
  // justify-defect: every occurrence names a canonical displayed resource.
  if (parsed === null) throw new Error(`invalid canonical resource ref: ${ref}`);
  const type = resourceType(parsed.scheme, item === null ? null : itemMediaKind(item));
  const identity = resourceTypeName(type);
  const label = presentation.label ?? identity;
  const marker = parsed.scheme === "note_block" ? "•" : <ResourceTypeIcon type={type}/>;
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
  const [annotationActive, setAnnotationActive] = useState(false);
  const [annotationOutline, setAnnotationOutline] = useState<OutlineAnnotationCapability | null>(null);
  const showChildren = useRef<() => void>(() => {});
  showChildren.current = () => {if (outline) outline.toggle(occurrenceKey, true); else setLocalOpen(true);};
  const childController = useCallback((controller: OutlineController | null) => {
    const capability = controller?.annotation(controller.pending.root_id) ?? null;
    setAnnotationOutline(capability === null ? null : {...capability, split: async (document, displayed) => {
      const admitted = await capability.split(document, displayed);
      if (admitted) showChildren.current();
      return admitted;
    }});
  }, []);
  const removals = useContext(FactRemovalsContext);
  const pendingRemoval = removals?.pending.get(occurrenceKey);
  const busy = pendingRemoval?.running ?? false;
  const rowWindow = useIndexRowWindow();
  const unsettled = busy || (pendingRemoval?.unknown ?? 0) > 0;
  useLayoutEffect(() => unsettled ? rowWindow?.pin() : undefined, [rowWindow, unsettled]);
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
    (outline?.view.folds.get(occurrenceKey) ?? localOpen ?? props.defaultOpen ?? (highlightId !== null && !props.inSource));
  useLayoutEffect(()=>{
    if(!hasControl&&lostArrowFocus.current&&element.current)outlineRowFocusTarget(element.current).focus({preventScroll:true});
    lostArrowFocus.current=false;
  },[hasControl]);
  const childrenId = useId();
  // one way, so a row flown past reads none of its children.
  const rested = useRef(false); rested.current ||= outline?.settled(occurrenceKey) ?? true;
  const childrenStarted = useRef(false);
  childrenStarted.current ||= annotationActive || open && hasChildren && rested.current;
  const removal = incoming?.kind === "edge" && writing !== null && !historical ? factRemoval(incoming) : null;
  async function toggle() {
    if (disclosureDisabled) return;
    if (open && props.beforeCollapse && !await props.beforeCollapse()) return;
    if (open && element.current?.contains(document.activeElement)) arrow.current?.focus({preventScroll: true});
    if (outline) outline.toggle(occurrenceKey, !open); else setLocalOpen(!open);
  }
  function removeFact() {
    if (!removal || !removals) return;
    const row = element.current;
    const fallback = row?.closest("[data-outline-scope]")?.querySelector<HTMLElement>('ul[tabindex="-1"]');
    const neighbours = fallback && row?.parentElement !== fallback ? [fallback]
      : [row?.nextElementSibling, row?.previousElementSibling, row?.parentElement?.closest("li")].flatMap(node => node
        ? [outlineRowFocusTarget(node as HTMLElement)] : []);
    if (fallback && !neighbours.includes(fallback)) neighbours.push(fallback);
    removals.remove(occurrenceKey, removal.command, untouched => {
      const ownsFocus = untouched && (row?.contains(document.activeElement) || document.activeElement === document.body);
      onChanged?.();
      outline?.refreshChildren();
      if (ownsFocus) neighbours.find(node => node.isConnected)?.focus({preventScroll: true});
    });
  }
  const commands: ActionDescriptor[] = [];
  if (incoming?.kind === "link" && !historical) commands.push({kind: "command", id: "Resource.Relation.unlink",
    label: `Unlink from ${incoming.parentLabel}`, icon: <Icon.Remove size={16} aria-hidden="true" />, restoreFocusOnClose: false, onSelect: () => incoming.unlink()});
  if (removal) commands.push({kind: "command", id: `Resource.Relation.${removal.id}`, label: removal.label, icon: <Icon.Remove size={16} aria-hidden="true" />,
    disabled: unsettled, busy, disabledReason: busy ? "removing" : undefined,
    restoreFocusOnClose: false, onSelect: removeFact});
  const made = incoming?.kind === "edge" ? incoming.creation : null;
  if (made) commands.push({kind: "link", id: "Resource.Creation", label: "View creation", icon: null,
    href: made.message_id
      ? `/librarian?message=${made.message_id}`
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
    onClick={() => outline?.reveal(projection.target)} data-row-focusable="true"><Icon.Locate size={14}/></button>
    : hasChildren ? <button ref={attachDisclosure} type="button" className={styles.control}
      aria-label={`${open ? "collapse" : "expand"} linked resources for ${label}`} aria-expanded={open}
      aria-controls={open ? childrenId : undefined} disabled={item?.missing === true || disclosureDisabled}
      onClick={toggle} data-row-focusable="true"><Icon.Disclose open={open} size={14}/></button>
    : null;
  const anchor = commands.length ? <ContextualActionMenu navigation={null} title={label} subjectKey={`relationship:${occurrenceKey}`}
    sections={[{id: "Occurrence", actions: commands}]}
    label={`relationship actions for ${label}`} renderContextAnchor={bullet}/> : bullet({});
  if (projection.kind === "omit") return null;
  return <ResourceBranch value={childrenBranch}>
    <li {...rootProps} ref={attachRow} className={cx(styles.row, props.inSource && styles.inSource, inRow && styles.inRow, rootProps?.className)}
      tabIndex={rootProps?.tabIndex ?? 0} aria-label={rootProps?.["aria-label"] ?? `outline item: ${label}`}
      data-outline-occurrence={occurrenceKey} data-resource-ref={ref}>
      <div className={styles.head}>
        {inRow ? null : anchor}
        <div className={styles.content}>
          {presentation.primary}
          {presentation.annotation ? <HighlightAnnotation highlightRef={ref} resource={presentation.annotation.resource}
            rest={rested.current} occurrenceKey={occurrenceKey} editable={presentation.annotation.editable}
            focusRequest={annotationFocusRequest} onFocused={onAnnotationClose} outline={annotationOutline}
            onPrepareOutline={() => setAnnotationActive(true)}/> : null}
          {sourceContent}
          {presentation.status}
          {resourceDetails}
          {connection?.snapshot?.rationale ? <div className={styles.details}><MachineText variant="inline" origin={{label: "librarian"}}>
            {connection.snapshot.rationale}</MachineText></div> : null}
          {details}

        </div>
        <div className={styles.actions}><ContextualActionMenu omitResourceActions={props.omitResourceActions}
          title={label} subjectKey={occurrenceKey} resourceRef={assumeCanonicalResourceRef(item?.action_ref ?? ref)}
          navigation={item === null ? null : {
            key: `${occurrenceKey}:${JSON.stringify(item.activation)}`,
            fork: touch && runtime && item.activation.kind === "route" && item.activation.href !== null
              ? paneForkLink({ runtime, target: { href: item.activation.href, labelHint: label }, disabledReason: null }) : null,
          }} showSourceSubject={item !== null && item.action_ref !== item.ref}
          sections={rowActions ? [{id: "Occurrence", actions: rowActions}] : []} label={`more actions for ${label}`}/>
          {inRow ? anchor : null}{disclosure}</div>
      </div>
      {childrenStarted.current ? <div className={styles.children} data-outline-children="true"><section id={childrenId} aria-label="linked resources">
        <LocalOutline rootRef={ref} occurrencePrefix={occurrenceKey} onControllerReady={presentation.annotation?.editable ? childController : undefined} childrenVisible={open}/>
        {open && rested.current ? <Children ownerRef={ref} localOwnerRef={compatible?.local_ref??null} occurrenceKey={occurrenceKey}/> : null}</section></div> : null}
    </li>
  </ResourceBranch>;
}

/** An expanded occurrence: its local links, then its separately failable server facts. */
function Children({ownerRef, localOwnerRef, occurrenceKey}: {ownerRef: string; localOwnerRef:string|null; occurrenceKey: string}) {
  const branch=useContext(ResourceBranch);
  const remote = useRemoteConnections(ownerRef, occurrenceKey, useChangeStamp("Metadata"));
  return <>
    {localOwnerRef&&localOwnerRef!==ownerRef?<ResourceBranch value={enterOutlineOccurrence({branch,ref:localOwnerRef,target:{kind:"occurrence",key:occurrenceKey},edgeIds:[]})}><LocalOutline rootRef={localOwnerRef} occurrencePrefix={`${occurrenceKey}/owner`}/></ResourceBranch>:null}
    <RemoteConnections ownerRef={ownerRef} occurrencePrefix={occurrenceKey} list={remote}
      onChanged={() => void remote.refetch().catch(() => undefined)}/>
  </>;
}
