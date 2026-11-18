"use client";

/** React owns native controls and passive reference bodies in stable node-view
 * slots. Editable prose remains ProseMirror's contentDOM. */
import HighlightAnnotation from "./HighlightAnnotation";
import {createPortal} from "react-dom";
import {useRef, type MouseEvent as ReactMouseEvent} from "react";
import type {ResourceProjection} from "@nexus/authored/types";
import type {ActionMenuContextAnchorProps} from "@/components/ui/ActionMenuHost";
import {FullResourceBody} from "@/components/resources/ExcerptDisclosure";
import ResourceMetadata from "@/components/resources/ResourceMetadata";
import {Fact, Failed} from "@/components/feedback/Fact";
import {authoredItem} from "@/lib/notes/presentation";
import {mediaBibliographyMetadata} from "@/lib/resources/metadata";
import {useMediaSummaryIds} from "@/lib/media/MediaSummaryProvider";
import {useRemoteAdmission} from "@/lib/native/admissionHooks";
import {useCatalogState} from "@/lib/catalog/provider";
import {catalogMedia} from "@/lib/catalog/selectors";
import {catalogLine} from "@/lib/catalog/copy";
import {useActionFocusRecovery} from "@/lib/ui/useActionFocusRecovery";
import * as Icon from "@/lib/ui/icons";
import type {BranchRead, OutlineAnnotationCapability} from "@/lib/notes/outlineController";
import AuthoredReadFailure from "./AuthoredReadFailure";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import {ResourceTypeIcon} from "@/components/resources/ResourceType";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import {activateTargetLink} from "@/lib/panes/targetLinkActivation";
import {workspaceTargetActivationIntent} from "@/lib/ui/targetActivation";
import {parseResourceRef} from "@/lib/resourceGraph/resourceRef";
import {resourceType, resourceTypeName} from "@/lib/resources/type";
import type {ActionDescriptor} from "@/lib/ui/actionDescriptor";
import styles from "./OutlineEditorRow.module.css";
import factualStyles from "@/components/resources/ResourceContent.module.css";
import type {OutlineHistory} from "@/lib/notes/structure";
import {useAccountToday} from "@/lib/notes/accountDay";
import {useAuthoredQuery} from "@/lib/notes/hooks";
import {useWorkCheck} from "@/lib/notes/work";
import {useTouchCapable} from "@/lib/renderEnvironment/provider";

/** What a row's sign is. Written on the bullet as `data-marker`; the css reads it, never the drawing. */
type Marker = "terminal" | "task" | "habit" | "note" | "page" | "day" | "highlight" | "passage" | "other";

/** A task's or a live habit's sign is its row's bullet. A plain click or Space checks it; a modified click is the
 * selection's; Enter opens the item, as its bullet's link did; a press and drag lifts the row, so no press is cancelled.
 * It names a check, not a menu: the menu still opens by context menu and Shift+F10. */
function WorkSign({resource, today, history, context, anchorRef, className, marker, href, label, extended}: {
  resource: ResourceProjection; today: string | null; history: OutlineHistory; context: ActionMenuContextAnchorProps;
  anchorRef(node: HTMLElement | null): void; className: string; marker: Marker; href: string | null; label: string;
  extended(event: ReactMouseEvent): boolean;
}) {
  const runtime = usePaneRuntime();
  const check = useWorkCheck(resource, today, history);
  if (check === null) return null;
  return <button ref={anchorRef} id={context.id} type="button" role="checkbox" aria-checked={check.checked} aria-disabled={check.disabled || check.busy || undefined}
    aria-busy={context["aria-busy"] || check.busy} aria-label={check.label} className={className} tabIndex={0} data-outline-bullet="true" data-row-focusable="true" data-marker={marker}
    onContextMenu={context.onContextMenu} onPointerDown={context.onPointerDown} onPointerMove={context.onPointerMove} onPointerUp={context.onPointerUp}
    onPointerCancel={context.onPointerCancel} onClickCapture={context.onClickCapture}
    onClick={event => {if (!extended(event) && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey) void check.toggle();}}
    onKeyDown={event => {
      context.onKeyDown(event);
      if (event.defaultPrevented) return;
      // read before the check cancels Enter: a cancelled key is no one's to open.
      const activation = workspaceTargetActivationIntent(event, "activate");
      check.onKeyDown(event);
      if (!check.disabled && !check.busy && activation.kind === "Open" && href !== null)
        runtime?.activateTarget({target: {href, labelHint: label}, disposition: {kind: activation.intent === "new_pane" ? "Fork" : "Follow"}});
    }}><Icon.Task checked={check.checked} className={styles.glyph}/></button>;
}

/** Accepted live identities remain; cold offline references read the saved catalog. */
function EpisodeBibliography({mediaId, returnFocus}: {mediaId: string; returnFocus: () => HTMLElement | null}) {
  const live = useRemoteAdmission() === "Ready";
  const catalog = useCatalogState();
  const summaries = useMediaSummaryIds([mediaId]);
  const observed = summaries.resolve(mediaId);
  const showingLive = live || !summaries.pending(mediaId);
  const summary = showingLive ? observed : catalog.data === null ? null : catalogMedia(catalog.data, mediaId);
  const error = showingLive ? summaries.error : catalog.error;
  const line = error === null ? null : catalogLine(error);
  const names = useRef<HTMLSpanElement>(null);
  useActionFocusRecovery(names, returnFocus);
  return <>
    <span ref={names} className={factualStyles.bibliography}>
      {summary?.media_kind === "podcast_episode" ? <><span aria-hidden="true"> · </span>
        <ResourceMetadata parts={mediaBibliographyMetadata(summary)} linkSource/></> : null}
    </span>
    {error === null ? null : line !== null ? <Fact line={line}/> : <Failed error={error} noun="source metadata"
      retry={{run: showingLive ? summaries.retry : catalog.refresh, busy: showingLive ? summaries.retrying : catalog.loading}}/>}
  </>;
}

export interface OutlineRowChrome {
  row_id: string;
  ref: string | null;
  resource: ResourceProjection | null;
  kind: "note" | "title" | "reference";
  depth: number;
  parent_id: string | null;
  label: string;
  href: string | null;
  parentLabel: string;
  childrenAvailable: boolean;
  read: BranchRead;
  open: boolean;
  terminal: boolean;
  selected: boolean;
  /** visible links on the row's resource; 1 when unknown. */
  mirrors: number;
  /** the day the row stands under: its nearest dated ancestor page; null under none. */
  day: string | null;
  workOwners(owners: readonly string[]): void;
  annotation: OutlineAnnotationCapability | null;
  toggle(): void;
  select(): void;
  /** extends the standing item selection to this row; null while nothing is selected. */
  extend: (() => void) | null;
  unlink(): void;
  reveal(): void;
}
/** `openMenu` is the bullet menu's opener while the bullet is mounted; a touch hold released in place calls it. */
export interface OutlineRowMount {row_id: string; dom: HTMLElement; leading: HTMLElement; disclose: HTMLElement; trailing: HTMLElement; content: HTMLElement; presentation: HTMLElement; annotation: HTMLElement; openMenu: (() => void) | null}

export default function OutlineEditorRows({mounts, rows, history}: {mounts: readonly OutlineRowMount[]; rows: ReadonlyMap<string, OutlineRowChrome>; history:OutlineHistory}) {
  const runtime = usePaneRuntime();
  const today = useAccountToday();
  const coarse = useTouchCapable();
  // A node view can unmount while its row stays in the session. The admitted rows own the
  // source set, so scrolling past a citation does not by itself restart its subscription.
  const citations = new Map<string, Citation[]>();
  for (const {resource} of rows.values()) {
    if (resource?.kind === "highlight" && resource.source_ref !== null) citations.set(resource.source_ref, []);
  }
  const portals = mounts.flatMap(mount => {
    const row = rows.get(mount.row_id);
    if (!row) return [];
    const parsed = row.ref === null ? null : parseResourceRef(row.ref);
    // justify-defect: only uncommitted drafts lack a canonical resource ref.
    if (row.ref !== null && parsed === null) throw new Error(`invalid canonical resource ref: ${row.ref}`);
    const scheme = parsed === null ? "note_block" : parsed.scheme;
    const type = resourceType(scheme, null);
    const identity = resourceTypeName(type);
    const resource = row.resource;
    const work = resource?.kind === "note" && resource.work?.designation.enabled ? resource.work.designation.kind : null;
    // a habit under another day's page is a note there: it draws no check and offers none.
    const check = row.terminal || work === "habit" && row.day !== null && today !== null && row.day !== today ? null : work;
    const marker: Marker = row.terminal ? "terminal" : check ?? (scheme === "note_block" ? "note" : scheme === "page" ? resource?.local_date ? "day" : "page"
      : scheme === "highlight" ? "highlight" : ["evidence_span", "content_chunk", "fragment", "passage_anchor", "oracle_passage_anchor"].includes(scheme) ? "passage" : "other");
    const glyph = marker === "terminal" ? <Icon.Locate className={styles.glyph} aria-hidden="true"/> : marker === "note" ? null
      : marker === "day" ? <Icon.Today className={styles.glyph} aria-hidden="true"/>
      : marker === "highlight" ? <Icon.Highlight className={`${styles.glyph} ${styles.forced}`} aria-hidden="true"/> : <ResourceTypeIcon type={type}/>;
    const actions: ActionDescriptor[] = [];
    // a checked sign opens nothing by its click, so its menu carries the way in.
    if (check !== null && row.href) actions.push({kind: "link", id: "Outline.Open", label: "Open", icon: null, href: row.href,
      onActivate: event => activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}})});
    actions.push({kind: "command", id: "Outline.SelectBlock", label: "Select item", icon: null, restoreFocusOnClose: false, onSelect: row.select});
    if (row.childrenAvailable) actions.push(row.open
      ? {kind: "command", id: "Outline.CollapseBlock", label: "Collapse", icon: null, restoreFocusOnClose: false, onSelect: row.toggle}
      : {kind: "command", id: "Outline.ExpandBlock", label: "Expand", icon: null, restoreFocusOnClose: false, onSelect: row.toggle});
    if (row.ref !== null) actions.push({kind: "command", id: "Resource.Relation.unlink", label: `Unlink from ${row.parentLabel}`, icon: <Icon.Remove aria-hidden="true" />, restoreFocusOnClose: false, onSelect: row.unlink});
    const control = `${styles.control} ${styles.bullet}`;
    // a touch tap on a bullet extends a standing selection to its row; a fine pointer keeps click to open and shift-click to range.
    const extended = (event: ReactMouseEvent) => {
      if (!row.extend || !(event.nativeEvent instanceof PointerEvent) || event.nativeEvent.pointerType !== "touch") return false;
      event.preventDefault(); row.extend(); return true;
    };
    // native keyboard traversal uses the glyph as the row's tab stop; the drag reads the bullet's menu for a touch hold released in place.
    const leading = <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()} onPointerCancel={event => event.stopPropagation()}
      onContextMenu={event => event.stopPropagation()}>
      <ContextualActionMenu navigation={null} title={row.label} subjectKey={`outline:${row.row_id}`} label={`actions for ${row.label}`} hold="external"
        sections={[{id: "Occurrence", actions}]} renderContextAnchor={(context, menu) => {
          const ref = (node: HTMLElement | null) => {context.ref(node); mount.openMenu = node ? menu.open : null;};
          return row.terminal ? <button {...context} ref={ref} type="button" className={control} tabIndex={0} data-outline-bullet="true" data-row-focusable="true" data-marker={marker}
            aria-label={`show earlier occurrence of ${row.label}`} onClick={event => {event.stopPropagation(); if (!extended(event)) row.reveal();}}>{glyph}</button>
          : check !== null ? <WorkSign resource={resource!} today={today} history={history} context={context} anchorRef={ref} className={control} marker={marker}
            href={row.href} label={row.label} extended={extended}/>
          : row.href ? <a {...context} ref={ref} className={control} href={row.href} tabIndex={0} data-outline-bullet="true" data-row-focusable="true" data-marker={marker}
            aria-label={`open ${identity}: ${row.label}`} data-workspace-rich-target="true"
            onClick={event => {if (!extended(event)) activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}});}}
            onKeyDown={event => {context.onKeyDown(event); if (!event.defaultPrevented) activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}});}}>{glyph}</a>
          : <button {...context} ref={ref} type="button" className={control} tabIndex={0} data-outline-bullet="true" data-marker={marker}
            data-row-focusable="true" aria-label={`actions for ${identity}: ${row.label}`} onClick={extended}>{glyph}</button>;
        }}/>
    </span>;
    const disclose = row.childrenAvailable ? <button type="button" className={styles.control} inert={coarse} data-row-focusable={coarse ? undefined : "true"}
      aria-label={`${row.open ? "collapse" : "expand"} ${row.label}`} aria-expanded={row.open} aria-busy={row.read.pending}
      onKeyDown={event => event.stopPropagation()} onClick={event => {event.stopPropagation(); row.toggle();}}><Icon.Disclose open={row.open} size={12}/></button> : null;
    // tails never change on hover. a repeat's figure is a floor: the links loaded here, not all there are.
    const trailing = <>
      {work === "habit" || row.terminal || row.mirrors > 1 ? <span className={styles.tail}>
        {work === "habit" ? <span>daily</span> : null}
        {row.terminal ? <span>see above</span> : null}
        {row.mirrors > 1 ? <span className={styles.repeat}><Icon.Repeat size={12} aria-hidden="true"/><span aria-hidden="true">{row.mirrors}+</span>
          <span className="sr-only">appears under at least {row.mirrors} parents</span></span> : null}
      </span> : null}
      <AuthoredReadFailure {...row.read} noun="linked items"/>
    </>;
    if (row.kind === "reference" && resource?.kind === "highlight" && resource.source_ref !== null) {
      const locator = resource.selection?.locator;
      const citation = {mount, page: locator?.type === "pdf_page_geometry" ? locator.page_number : null};
      citations.get(resource.source_ref)!.push(citation);
    }
    return [createPortal(leading, mount.leading, `${row.row_id}:leading`), createPortal(disclose, mount.disclose, `${row.row_id}:disclose`), createPortal(trailing, mount.trailing, `${row.row_id}:trailing`),
      ...(row.kind === "reference" && row.ref !== null ? [createPortal(<>
        {resource?.kind === "highlight" ? <div className={styles.excerpt}><FullResourceBody item={authoredItem(resource, null, row.href)}/></div> : resource?.excerpt ? <FullResourceBody item={authoredItem(resource, null, row.href)} /> : row.href ? <a href={row.href} data-workspace-rich-target="true" onClick={event => activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}})}>{row.label}</a> : row.label}
        {scheme === "media" ? <EpisodeBibliography mediaId={parsed!.id} returnFocus={() => mount.leading.querySelector<HTMLElement>("[data-row-focusable]")}/> : null}
      </>, mount.presentation, `${row.row_id}:content`), ...(resource?.kind === "highlight" ? [createPortal(<HighlightAnnotation highlightRef={resource.ref} resource={resource} occurrenceKey={row.row_id} editable={row.annotation !== null} outline={row.annotation} onWorkOwners={row.workOwners}/>, mount.annotation, `${row.row_id}:annotation`)] : [])] : [])];
  });
  const sources = [...citations.keys()].sort();
  const batches = [];
  for (let start = 0; start < sources.length; start += 100) {
    batches.push(<HighlightCitations key={start} sources={sources.slice(start, start + 100)} citations={citations}/>);
  }
  return <>{portals}{batches}</>;
}

type Citation = {mount: OutlineRowMount; page: number | null};

/** Each local resolve admits up to 100 distinct sources. Keep the excerpt and annotation mounted
 * when a source enters or leaves a batch. Only its citation depends on this read. */
function HighlightCitations({sources, citations}: {sources: string[]; citations: ReadonlyMap<string, Citation[]>}) {
  const read = useAuthoredQuery({kind: "resolve", refs: sources});
  return <>
    <AuthoredReadFailure {...read} noun="highlight sources"/>
    {read.data?.rows.flatMap(({resource}) => {
      const title = resource.title?.trim();
      if (!title) return [];
      return (citations.get(resource.ref) ?? []).map(({mount, page}) => createPortal(
        <span className={styles.citation}>{title}{page !== null ? <><span aria-hidden="true"> · </span>page {page}</> : null}</span>,
        mount.presentation, mount.row_id,
      ));
    })}
  </>;
}
