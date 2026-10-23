"use client";

import Button from "@/components/ui/Button";

// Outline markup owns hierarchy and editing; the canonical resource projection owns facts.
import {useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type HTMLAttributes, type ReactNode, type Ref} from "react";
import {ChevronRight, CornerLeftUp} from "lucide-react";
import {FeedbackNotice, useFeedback, type FeedbackContent} from "@/components/feedback/Feedback";
import AnnotationNoteHost from "@/components/notes/AnnotationNoteHost";
import CanonicalNoteEditor from "@/components/notes/CanonicalNoteEditor";
import PageTitleEditor from "@/components/notes/PageTitleEditor";
import type {StructuralKeys} from "@/components/notes/NoteEditor";
import {fetchNote} from "@/lib/notes/api";
import {adoptText, useText} from "@/lib/notes/texts";
import type {DailyPublication, OutlineDestination, OutlinePlacement, OutlineSession} from "@/lib/notes/useOutlineSession";
import {usePaneFreeServerValue} from "@/lib/api/serverState";
import MachineText from "@/components/ui/MachineText";
import {isApiError} from "@/lib/api/client";
import {assertNever} from "@/lib/assertNever";
import type {Schema} from "@/lib/api/wire";
import {handleUnauthenticatedApiError} from "@/lib/auth/UnauthenticatedApiBoundary";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import {activateTargetLink} from "@/lib/panes/targetLinkActivation";
import {connectionMutationErrorMessage, mutateConnection, type ConnectionCommand,
 type ConnectionMutation, type ConnectionOut, type InsertionSource} from "@/lib/resourceGraph/links";
import {useResourceDraft} from "@/lib/resourceGraph/useResourceDraft";
import {classifyOutlineOccurrence, enterOutlineOccurrence} from "@/lib/resources/outlineProjection";
import {resourceMetadata} from "@/lib/resources/metadata";
import {useResolvedResourceItem} from "@/lib/media/mediaSummary";
import {assumeCanonicalResourceRef} from "@/lib/sharing/targets";
import type {ActionDescriptor} from "@/lib/ui/actionDescriptor";
import type {ActionMenuContextAnchorProps} from "@/components/ui/ActionMenu";
import {cx} from "@/lib/ui/cx";
import ContextualActionMenu from "./ContextualActionMenu";
import ResourceBody, {ResourceMatchEvidence, type ResourceMatch} from "./ResourceBody";
import ResourceMetadata from "./ResourceMetadata";
import {OutlineSessionContext, ResourceBranch, ResourceOutlineContext} from "./ResourceOutlineList";
import OutlineInsertionLine from "@/components/notes/OutlineInsertionLine";
import {useResourceOutline} from "@/lib/resourceGraph/useResourceOutline";
import ResourceDisclosure from "./ResourceDisclosure";
import styles from "./ResourceOutline.module.css";
import factualStyles from "./ResourceContent.module.css";
type Item = Schema<"ResourceItemOut">;
type PlacementBranch = {expanded: boolean; toggle(): void; children: ReactNode};
export type Incoming = {kind: "edge"; edge_id: string; origin: ConnectionOut["origin"];
  mutation: ConnectionMutation | null; creation: ConnectionOut["creation"]}
  | null;
export default function ResourceOutlineRow(props: {
  item: Item;
  occurrenceKey: string;
  incoming: Incoming;
  connection?: ConnectionOut;
  edgeId?: string;
  representedEdgeIds?: readonly string[];
  embeddedInNoteRef?: string | null;
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
  userUnlinkAction?: Extract<ActionDescriptor, { kind: "command" }> | null;
  commandDisabledReason?: string;
  placement?: PlacementBranch;
  rootProps?: HTMLAttributes<HTMLElement> & {
    "data-active"?: boolean;
    "data-selected"?: boolean;
  };
  rowRef?: Ref<HTMLLIElement>;
  historical?: boolean;
  historicalBranch?: boolean;
  continuation?: OutlineDestination | null;
  insertionSource?: InsertionSource | null;
  authoredPlacement?: OutlinePlacement | null;
  pageContent?: Schema<"PageContentOut"> | null;
  noteAuthority?: "current" | "local";
  noteEditable?: boolean;
  noteKeys?: StructuralKeys;
  notePublication?: DailyPublication;
  noteEmbeddedItem?: Item | null;
  indentDestination?: OutlineDestination | null;
  annotationFocusRequest?: number | null;
  onAnnotationClose?: () => void;
}) {
  const {occurrenceKey, incoming, connection, edgeId, representedEdgeIds = [], embeddedInNoteRef = null,
    occurrenceLabel, onChanged, primaryLinkRef, match, matchMethod, body, sourceContent, resourceDetails,
    nestedContent, details, userUnlinkAction = null, placement, rootProps, rowRef, historical = false,
    historicalBranch = false, noteEditable = true, noteKeys, notePublication,
    noteEmbeddedItem = null, annotationFocusRequest = null, onAnnotationClose} = props;
  const item = useResolvedResourceItem(props.item, historical);
  const noteAuthority = props.noteAuthority ?? (!historical && !item.missing && item.ref.startsWith("note_block:") ? "current" : undefined);
  const runtime = usePaneRuntime();
  const feedback = useFeedback();
  const session = useContext(OutlineSessionContext);
  const outline = useContext(ResourceOutlineContext);
  const branch = useContext(ResourceBranch);
  const commandDisabledReason = props.commandDisabledReason ??
    (session?.activeReference != null ? "finish linking or return to prose first" : undefined);
  const disclosureDisabled = (outline?.viewLocked ?? false) || session?.activeReference != null;
  const enteringEdgeId = edgeId ?? (incoming?.kind === "edge" ? incoming.edge_id : null);
  const projection = classifyOutlineOccurrence({branch, targetRef: item.ref, edgeId: enteringEdgeId});
  const terminal = projection.kind === "reference";
  const childrenBranch = useMemo(() => enterOutlineOccurrence({branch, ref: item.ref,
    target: {kind: "occurrence", key: occurrenceKey},
    edgeIds: [...representedEdgeIds, ...(enteringEdgeId === null ? [] : [enteringEdgeId])]}),
    [branch, enteringEdgeId, item.ref, occurrenceKey, representedEdgeIds]);
  const [localOpen, setLocalOpen] = useState(false);
  const open = projection.kind === "resource" && (placement?.expanded ?? outline?.view.folds.get(occurrenceKey) ?? localOpen);
  const defaultSource = historical || item.missing ? null : props.insertionSource === undefined
    ? session?.insertionCapability(item.ref) ?? null : props.insertionSource;
  const continuation = props.continuation === undefined ? defaultSource ? {
    source: defaultSource, position: null, occurrencePrefix: occurrenceKey, path: [],
  } : null : props.continuation;
  const annotationEdit = useResourceDraft(`Annotations.Active:${occurrenceKey}`, () => false);
  const [annotationActivation, setAnnotationActivation] = useState<number | null>(null);
  const activationSerial = useRef(0);
  const activateAnnotation = () => {
    if (session?.activeReference != null) return;
    if (!annotationEdit.value) setAnnotationActivation(++activationSerial.current);
    annotationEdit.set(true);
  };
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const submitted = useRef<ConnectionCommand | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{error: unknown} | null>(null);
  const element = useRef<HTMLLIElement | null>(null);
  const attachRow = useCallback((node: HTMLLIElement | null) => {
    element.current = node;
    if (typeof rowRef === "function") rowRef(node); else if (rowRef) rowRef.current = node;
  }, [rowRef]);
  const arrow = useRef<HTMLButtonElement | null>(null);
  const childrenId = useId();
  const effectiveIncoming = incoming;
  const mutation = incoming?.mutation ?? null;
  const userLink = incoming?.kind === "edge" && incoming.origin === "user";
  const metadata = resourceMetadata({item, matchMethod, occurrenceLabel});
  const activation = item.activation;
  const unavailable = activation.unavailable_reason === "location_unavailable" ? "quoted location unavailable"
    : activation.unavailable_reason === "source_unavailable" ? "source unavailable" : null;
  const removalLabel = mutation?.kind === "detach_context" ? "remove from future context"
    : `unlink from ${connection ? (connection.source.ref === item.ref ? connection.target.label : connection.source.label) : "parent"}`;
  const annotation = item.preview.annotation;
  function toggle() {
    if (disclosureDisabled) return;
    if (open && element.current?.contains(document.activeElement)) arrow.current?.focus({preventScroll: true});
    if (placement) placement.toggle(); else if (outline) outline.toggle(occurrenceKey, !open); else setLocalOpen(!open);
  }
  useLayoutEffect(() => {
    if (!open && !terminal && session?.focus?.key.startsWith(`${occurrenceKey}/`)) {
      if (placement) placement.toggle(); else if (outline) outline.toggle(occurrenceKey, true); else setLocalOpen(true);
    }
  }, [session?.focus, open, terminal, occurrenceKey, outline, placement]);
  async function mutate(retry = false) {
    if (!effectiveIncoming || !mutation || busyRef.current || commandDisabledReason)
      return;
    let command = submitted.current;
    if (!retry) {
      switch (mutation.kind) {
        case "unlink":
          command = { kind: "unlink", link_id: effectiveIncoming.edge_id };
          break;
        case "detach_context":
          command = mutation;
          break;
        default:
          return assertNever(mutation);
      }
    }
    if (!command) return;
    submitted.current = command;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setRefreshRequired(false);
    const row = element.current;
    const fallback = row
      ?.closest("[data-outline-scope]")
      ?.querySelector<HTMLElement>('ul[tabindex="-1"]');
    // A nested fact may retire its whole ancestor after the acknowledged reread.
    const neighbours = fallback && row?.parentElement !== fallback
      ? [fallback]
      : [row?.nextElementSibling, row?.previousElementSibling,
          row?.parentElement?.closest("li")].flatMap((node) => node
            ? [node.querySelector<HTMLElement>("[data-row-focusable]:not(:disabled)") ?? (node as HTMLElement)]
            : []);
    if (fallback && !neighbours.includes(fallback)) neighbours.push(fallback);
    let ownsFocus = true;
    const release = () => {
      ownsFocus = false;
    };
    document.addEventListener("pointerdown", release, true);
    document.addEventListener("keydown", release, true);
    try {
      await mutateConnection(command);
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        let content: FeedbackContent;
        try {
          content = connectionMutationErrorMessage(error);
        } catch (defect) {
          setDefect({ error: defect });
          return;
        }
        submitted.current = null;
        if (command.kind === "unlink") {
          feedback.offer({
            key: `connection-remove:${command.link_id}`,
            content: { ...content, title: "this connection can’t be removed here" },
            announcement: "Polite",
            actions: [{ label: "refresh connections", onClick: () => onChanged?.() }],
          });
          onChanged?.();
        } else {
          setFailure(content);
          if (isApiError(error) && error.code === "E_CONTEXT_CHANGED")
            setRefreshRequired(true);
          else submitted.current = command;
        }
      }
      return;
    } finally {
      document.removeEventListener("pointerdown", release, true);
      document.removeEventListener("keydown", release, true);
      busyRef.current = false;
      setBusy(false);
    }
    submitted.current = null;
    feedback.receipt({
      tone: "Success",
      title: command.kind === "detach_context" ? "removed from future context"
        : userLink ? "link removed; notes kept" : "connection removed",
    });
    const mayRestoreFocus = ownsFocus &&
      (row?.contains(document.activeElement) || document.activeElement === document.body);
    onChanged?.();
    if (mayRestoreFocus && (row?.contains(document.activeElement) || document.activeElement === document.body))
      neighbours.find((node) => node.isConnected)?.focus({ preventScroll: true });
  }

  const selected = session?.selection?.kind === "blocks" && session.selection.keys.includes(occurrenceKey);
  const siblings = () => Array.from(element.current?.parentElement?.children ?? [])
    .flatMap(child => child.getAttribute("data-outline-occurrence") ?? []);
  useLayoutEffect(() => {
    if (!session) return;
    return session.registerOccurrence(occurrenceKey, {
      destination: continuation, placement: props.authoredPlacement ?? null,
      indentDestination: props.indentDestination?.source.kind === "resource"
        ? {...props.indentDestination, source: props.indentDestination.source} : null,
      editable: !historical && !item.missing && !outline?.viewLocked,
      unlink: mutation?.kind === "unlink" && !busy ? () => {
        if (userUnlinkAction) userUnlinkAction.onSelect({triggerEl: element.current, openIntent: "default"}); else void mutate();
      } : null,
    });
  });
  useLayoutEffect(() => {if (selected && !rootProps?.onKeyDown) element.current?.focus({preventScroll: true});}, [selected, rootProps?.onKeyDown]);
  const commands: ActionDescriptor[] = [];
  if (userUnlinkAction) commands.push(userUnlinkAction);
  else if (mutation) commands.push({kind: "command", id: `Resource.Relation.${mutation.kind}`,
    label: removalLabel, disabled: busy, disabledReason: busy ? "removal is pending" : undefined,
    restoreFocusOnClose: false, onSelect: () => void mutate()});
  const made = incoming?.kind === "edge" ? incoming.creation : null;
  if (made) commands.push({kind: "link", id: "Resource.Creation", label: "view creation",
    href: made.conversation_id && made.message_id
      ? `/conversations/${made.conversation_id}?message=${made.message_id}`
      : `/settings/account?generation_id=${made.generation_id}&tool_call_id=${made.tool_call_id}#assistant-writes`});
  const menu = {
    title: item.label, subjectKey: occurrenceKey,
    resourceRef: assumeCanonicalResourceRef(item.action_ref),
    displayedActivation: item.activation,
    showSourceSubject: item.action_ref !== item.ref,
    commandDisabledReason,
    sections: [],
  };
  const bullet = (context: Partial<ActionMenuContextAnchorProps>) => activation.href ? <a
    {...context} data-outline-bullet="true" className={cx(styles.control, styles.bullet)} href={activation.href}
    aria-label={`open ${metadata.identity}: ${item.label}`} data-workspace-rich-target="true" data-row-focusable="true"
    onClick={event => activateTargetLink({event, runtime, target: {href: activation.href!, labelHint: item.label}})}
    onKeyDown={event => {context.onKeyDown?.(event); if (!event.defaultPrevented)
      activateTargetLink({event, runtime, target: {href: activation.href!, labelHint: item.label}});}}>•</a>
    : <button {...context} type="button" disabled={commands.length === 0} data-outline-bullet="true" className={cx(styles.control, styles.bullet)}
      aria-label={unavailable ?? `actions for unavailable ${item.label}`} data-row-focusable="true">•</button>;
  const page = props.pageContent ?? null;
  const primaryBody = body ?? (noteAuthority && !historical && session ? <LiveNoteBody
    item={item} occurrenceKey={occurrenceKey} authority={noteAuthority} editable={noteEditable}
    structuralKeys={noteKeys} publication={notePublication} embeddedItem={noteEmbeddedItem}
    terminal={terminal} continuation={continuation} session={session}/>
    : !historical && !terminal && session && item.ref.startsWith("page:") ? page ? <PageTitleEditor session={session}
      occurrence={{key: occurrenceKey, noteRef: item.ref}} content={page} editable={noteEditable}
      continuation={continuation} label={`edit page title: ${item.label}`}/>
      : <LivePageTitle item={item} session={session} occurrenceKey={occurrenceKey} continuation={continuation} editable={noteEditable}/>
    : null);
  if (defect) throw defect.error;
  if (projection.kind === "omit") return null;
  return <ResourceBranch value={childrenBranch}>
    <li {...rootProps} ref={attachRow} className={cx(styles.row, rootProps?.className)}
      tabIndex={rootProps?.tabIndex ?? 0} aria-label={rootProps?.["aria-label"] ?? `outline item: ${item.label}`}
      data-selected={selected || undefined} data-outline-occurrence={occurrenceKey} data-resource-ref={item.ref}
      onClick={event => {
        rootProps?.onClick?.(event);
        if (!rootProps?.onClick && event.target instanceof Element && !event.target.closest("a,button,input,textarea,select,[contenteditable=true]"))
          session?.selectOccurrence(occurrenceKey, event.shiftKey, siblings());
      }}
      onKeyDown={event => {
        rootProps?.onKeyDown?.(event);
        if (event.defaultPrevented || event.target !== event.currentTarget || event.nativeEvent.isComposing || !session) return;
        if (event.key === " " && !selected) {event.preventDefault(); session.selectOccurrence(occurrenceKey); return;}
        if (!selected) return;
        const mac = /Mac|iPhone|iPad/.test(navigator.platform);
        if ((mac ? event.metaKey : event.ctrlKey) && event.key.toLowerCase() === "z") {
          event.preventDefault(); session.executeCommand(event.shiftKey ? "redo" : "undo");
        } else if (event.key === "Escape") {
          event.preventDefault(); session.clearSelection();
          element.current?.querySelector<HTMLElement>("[data-outline-bullet]")?.focus();
        } else if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && !event.repeat) {
          event.preventDefault(); session.executeCommand("insert");
        } else if (event.key === "Tab" && !event.altKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault(); session.executeCommand(event.shiftKey ? "outdent" : "indent");
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault(); const direction = event.key === "ArrowUp" ? -1 : 1;
          if (event.shiftKey && (mac ? event.metaKey : event.altKey)) session.executeCommand(direction < 0 ? "move_up" : "move_down");
          else {const keys = siblings(), next = keys[keys.indexOf(occurrenceKey)+direction];
            if (next) session.selectOccurrence(next,event.shiftKey,keys);}
        } else if (["Delete","Backspace"].includes(event.key) && !event.repeat && !event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey) {
          event.preventDefault(); session.unlinkSelectedOccurrence();
        }
      }}>
      <div className={styles.head}>
        {projection.kind === "reference" ? <button ref={arrow} type="button" className={styles.control}
          disabled={disclosureDisabled} aria-label={`show earlier occurrence of ${item.label}`}
          onClick={() => outline?.reveal(projection.target)} data-row-focusable="true"><CornerLeftUp size={14}/></button>
          : <button ref={arrow} type="button" className={styles.control}
            aria-label={`expand linked resources for ${item.label}`} aria-expanded={open}
            aria-controls={open ? childrenId : undefined} disabled={item.missing || disclosureDisabled}
            onClick={toggle} data-row-focusable="true"><ChevronRight size={14} className={styles.arrow} data-open={open || undefined}/></button>}
        {commands.length ? <ContextualActionMenu title={item.label} subjectKey={`relationship:${occurrenceKey}`}
          sections={[{id: "Occurrence", actions: commands}]} commandDisabledReason={commandDisabledReason}
          label={`relationship actions for ${item.label}`} renderContextAnchor={bullet}/> : bullet({})}
        <div className={styles.content}>
          {primaryBody ?? <div className={styles.reference}>
            {activation.href ? <a ref={primaryLinkRef} className={styles.primaryLink} href={activation.href}
              aria-label={`open ${item.label}`} data-workspace-rich-target="true"
              onClick={event => activateTargetLink({event, runtime, target: {href: activation.href!, labelHint: item.label}})}
              onKeyDown={event => activateTargetLink({event, runtime, target: {href: activation.href!, labelHint: item.label}})}>
              <ResourceBody body={item.preview.body} match={match}/></a> : <ResourceBody body={item.preview.body} match={match}/>}
            {metadata.bibliography.length ? <span className={factualStyles.bibliography}><span className={styles.separator}> · </span><ResourceMetadata parts={metadata.bibliography} linkSource={false}/></span> : null}
          </div>}
          {sourceContent}
          {item.preview.body.kind === "named" && match?.excerpt.text && match.excerpt.text !== item.preview.body.title
            ? <ResourceMatchEvidence match={match}/> : null}
          {item.ref.startsWith("highlight:") && (annotation || annotationEdit.value || annotationFocusRequest !== null) ?
            <AnnotationNoteHost target={{kind: "highlight", id: item.ref.slice("highlight:".length)}}
              noteRef={annotation?.note_ref ?? null} completeAnnotation={annotation} occurrenceKey={occurrenceKey}
              label={`edit note: ${annotation?.body_text.split("\n")[0] || item.label}`}
              editable={!terminal && !historical} atomicEmbeds={terminal || historical}
              focusRequest={annotationFocusRequest ?? annotationActivation ?? 0} onActivate={activateAnnotation}
              onChanged={() => onChanged?.()} onClose={() => {annotationEdit.set(false); setAnnotationActivation(null); onAnnotationClose?.();}}/> : null}
          {!historical && !terminal && item.ref.startsWith("highlight:") && !annotation && !annotationEdit.value ?
            <Button className={styles.textButton} onClick={activateAnnotation}>add note</Button> : null}
          {metadata.parts.length ? <div className={styles.metadata}><ResourceMetadata parts={metadata.parts} linkSource/></div> : null}
          {unavailable ? <p className={styles.status}>{unavailable}</p> : null}
          {resourceDetails}
          {connection?.snapshot?.rationale ? <div className={styles.details}><MachineText variant="inline" origin={{label: "librarian"}}>{connection.snapshot.rationale}</MachineText></div> : null}
          {details}
          {failure ? <FeedbackNotice content={failure} announcement="Assertive" actions={[
            refreshRequired ? {label: "refresh context", onClick: () => {setFailure(null); onChanged?.();}}
            : {label: "retry", onClick: () => void mutate(true)}]}/> : null}
        </div>
        <div className={styles.actions}><ContextualActionMenu {...menu} label={`more actions for ${item.label}`}/></div>
      </div>
      {!open && session?.composer?.destination.occurrencePrefix === occurrenceKey && continuation &&
        session.composer.destination.path.join("/") === continuation.path.join("/") ?
          <OutlineInsertionLine session={session} destination={session.composer.destination}/> : null}
      {nestedContent || open ? <div className={styles.children}>{nestedContent}{open ?
        <section id={childrenId} aria-label="linked resources">{placement?.children ?? <ResourceDisclosure
          resourceRef={item.ref} occurrencePrefix={occurrenceKey} readOnly={historical}
          historicalBranch={historicalBranch || historical} embeddedInNoteRef={embeddedInNoteRef}
          suppressedEdgeIds={annotation ? [annotation.attachment_edge_id] : []}/>}</section> : null}</div> : null}
    </li>
  </ResourceBranch>;
}

function LivePageTitle({item, session, occurrenceKey, continuation, editable}: {
  item: Item; session: OutlineSession; occurrenceKey: string; continuation: OutlineDestination | null; editable: boolean;
}) {
  const read = useResourceOutline(item.ref);
  const adopt = session.adoptOutline;
  const {source, items, version, complete, generation, status, insertionSource} = read;
  useEffect(() => {adopt({source, items, version, complete, generation, status, insertionSource});},
    [adopt, source, items, version, complete, generation, status, insertionSource]);
  const content = read.source?.content;
  if (content?.kind === "page") return <PageTitleEditor session={session} occurrence={{key: occurrenceKey, noteRef: item.ref}}
    content={content} continuation={continuation} editable={editable} label={`edit page title: ${item.label}`}/>;
  return read.error ? <FeedbackNotice content={{tone: "Warning", title: "couldn’t load page title", requestId: read.error.requestId}}
    announcement="Polite" actions={[{label: "retry", onClick: read.retry}]}/> : <p role="status">loading page title…</p>;
}

export function connectionOriginLabel(origin: ConnectionOut["origin"], historicalBranch = false): string {
  if (historicalBranch && origin === "highlight_note") return "current annotation";
  switch (origin) {
    case "user": return "linked by you";
    case "citation": return "citation";
    case "discovery": return "linked automatically by the librarian";
    case "assistant": return "linked by the librarian";
    case "system": return "added to chat";
    case "highlight_note": return "annotation";
    case "note_body": return "embedded resource";
    case "document_embed": return "attachment";
  }
}
function LiveNoteBody({
  item,
  occurrenceKey,
  authority,
  editable,
  structuralKeys,
  publication,
  embeddedItem,
  terminal,
  continuation,
  session,
}: {
  item: Item;
  occurrenceKey: string;
  authority: "current" | "local";
  editable: boolean;
  structuralKeys?: StructuralKeys;
  publication?: DailyPublication;
  embeddedItem: Item | null;
  terminal: boolean;
  continuation: OutlineDestination | null;
  session: OutlineSession;
}) {
  const text = useText(item.ref);
  const note = usePaneFreeServerValue<Schema<"NoteBlockOut">>({
    key:
      authority === "current" && text?.acked == null
        ? `/notes/blocks/${encodeURIComponent(item.ref.slice("note_block:".length))}`
        : null,
    stale: "",
    load: (signal) => fetchNote(item.ref.slice("note_block:".length), signal),
  });
  const loaded = note.status === "ready" ? note.data : null;
  useEffect(() => {
    if (loaded !== null)
      adoptText(
        item.ref,
        { body_pm_json: loaded.body_pm_json, body_text: loaded.body_text },
        loaded.body_version,
      );
  }, [item.ref, loaded]);
  if (authority === "local" && (!text || typeof text.value === "string"))
    throw new Error("a local note occurrence requires its canonical draft");
  return (
    <div>
      {(!text || typeof text.value === "string") && loaded === null ? (
        note.status === "failed" ? (
          <FeedbackNotice
            content={{
              tone: "Warning",
              title: "couldn’t load note",
              requestId: note.error.requestId,
            }}
            announcement="Polite"
            actions={[{ label: "retry", onClick: note.refetch }]}
          />
        ) : (
          <p role="status">loading note…</p>
        )
      ) : (
        <CanonicalNoteEditor
          session={session}
          occurrence={{ key: occurrenceKey, noteRef: item.ref }}
          continuation={terminal ? null : continuation}
          label={`edit note: ${item.label}`}
          editable={editable && !terminal}
          atomicEmbeds={terminal}
          embeddedItem={embeddedItem ?? loaded?.embedded_item ?? null}
          publication={publication}
          structuralKeys={structuralKeys}
        />
      )}
    </div>
  );
}
