"use client";

/** React owns native controls and passive reference bodies in stable node-view
 * slots. Editable prose remains ProseMirror's contentDOM. */
import HighlightAnnotation from "./HighlightAnnotation";
import type {TextEditorHandle} from "./NoteEditor";
import {createPortal} from "react-dom";
import type {MouseEvent as ReactMouseEvent} from "react";
import type {ResourceProjection} from "@nexus/authored/types";
import {FullResourceBody} from "@/components/resources/ExcerptDisclosure";
import {authoredItem} from "@/lib/notes/presentation";
import * as Icon from "@/lib/ui/icons";
import type {BranchRead} from "@/lib/notes/outlineController";
import AuthoredReadFailure from "./AuthoredReadFailure";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import {ResourceTypeIcon} from "@/components/resources/ResourceType";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import {activateTargetLink} from "@/lib/panes/targetLinkActivation";
import {parseResourceRef} from "@/lib/resourceGraph/resourceRef";
import {resourceType, resourceTypeName} from "@/lib/resources/type";
import type {ActionDescriptor} from "@/lib/ui/actionDescriptor";
import styles from "./OutlineEditorRow.module.css";

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
  workOwners(owners: readonly string[]): void;
  editorReady(editor: TextEditorHandle | null): void;
  toggle(): void;
  select(): void;
  /** extends the standing item selection to this row; null while nothing is selected. */
  extend: (() => void) | null;
  unlink(): void;
  reveal(): void;
}
/** `openMenu` is the bullet menu's opener while the bullet is mounted; a touch hold released in place calls it. */
export interface OutlineRowMount {row_id: string; dom: HTMLElement; leading: HTMLElement; disclose: HTMLElement; trailing: HTMLElement; content: HTMLElement; input: TextEditorHandle | null; openMenu: (() => void) | null}

export default function OutlineEditorRows({mounts, rows}: {mounts: readonly OutlineRowMount[]; rows: ReadonlyMap<string, OutlineRowChrome>}) {
  const runtime = usePaneRuntime();
  return mounts.flatMap(mount => {
    const row = rows.get(mount.row_id);
    if (!row) return [];
    const parsed = row.ref === null ? null : parseResourceRef(row.ref);
    // justify-defect: only uncommitted drafts lack a canonical resource ref.
    if (row.ref !== null && parsed === null) throw new Error(`invalid canonical resource ref: ${row.ref}`);
    const scheme = parsed === null ? "note_block" : parsed.scheme;
    const type = resourceType(scheme, null);
    const identity = resourceTypeName(type);
    const marker = row.terminal ? <Icon.Locate size={14}/> : scheme === "note_block" ? "•" : <ResourceTypeIcon type={type}/>;
    const actions: ActionDescriptor[] = [{kind: "command", id: "Outline.SelectBlock", label: "Select item", icon: null, restoreFocusOnClose: false, onSelect: row.select}];
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
          return row.terminal ? <button {...context} ref={ref} type="button" className={control} tabIndex={0} data-outline-bullet="true" data-row-focusable="true"
            aria-label={`show earlier occurrence of ${row.label}`} onClick={event => {event.stopPropagation(); if (!extended(event)) row.reveal();}}>{marker}</button>
          : row.href ? <a {...context} ref={ref} className={control} href={row.href} tabIndex={0} data-outline-bullet="true" data-row-focusable="true"
            aria-label={`open ${identity}: ${row.label}`} data-workspace-rich-target="true"
            onClick={event => {if (!extended(event)) activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}});}}
            onKeyDown={event => {context.onKeyDown(event); if (!event.defaultPrevented) activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}});}}>{marker}</a>
          : <button {...context} ref={ref} type="button" className={control} tabIndex={0} data-outline-bullet="true"
            data-row-focusable="true" aria-label={`actions for ${identity}: ${row.label}`} onClick={extended}>{marker}</button>;
        }}/>
    </span>;
    const disclose = row.childrenAvailable ? <button type="button" className={styles.control} data-row-focusable="true"
      aria-label={`${row.open ? "collapse" : "expand"} ${row.label}`} aria-expanded={row.open} aria-busy={row.read.pending}
      onKeyDown={event => event.stopPropagation()} onClick={event => {event.stopPropagation(); row.toggle();}}><Icon.Disclose open={row.open} size={12}/></button> : null;
    const trailing = <>
      {row.mirrors > 1 ? <span data-mirrors={row.mirrors}><span aria-hidden="true">{row.mirrors}</span><span className="sr-only">appears under {row.mirrors} parents</span></span> : null}
      <AuthoredReadFailure {...row.read} title="couldn’t open linked resources"/>
    </>;
    return [createPortal(leading, mount.leading, `${row.row_id}:leading`), createPortal(disclose, mount.disclose, `${row.row_id}:disclose`), createPortal(trailing, mount.trailing, `${row.row_id}:trailing`),
      ...(row.kind === "reference" && row.ref !== null ? [createPortal(row.resource?.kind === "highlight" ? <div contentEditable={false}><FullResourceBody item={authoredItem(row.resource, null, row.href)} /><HighlightAnnotation highlightRef={row.resource.ref} resource={row.resource} occurrenceKey={row.row_id} editable={!row.terminal} onWorkOwners={row.workOwners} onEditorReady={row.editorReady}/></div> : row.resource?.excerpt ? <FullResourceBody item={authoredItem(row.resource, null, row.href)} /> : row.label,
        mount.content, `${row.row_id}:content`)] : [])];
  });
}
