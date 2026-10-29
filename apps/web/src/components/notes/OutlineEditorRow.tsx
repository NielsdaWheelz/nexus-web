"use client";

/** React owns native controls and passive reference bodies in stable node-view
 * slots. Editable prose remains ProseMirror's contentDOM. */
import HighlightAnnotation from "./HighlightAnnotation";
import type {TextEditorHandle} from "./NoteEditor";
import {createPortal} from "react-dom";
import type {ResourceProjection} from "@nexus/authored/types";
import {FullResourceBody} from "@/components/resources/ExcerptDisclosure";
import {authoredItem} from "@/lib/notes/presentation";
import {ChevronRight, CornerLeftUp, SquareDashedMousePointer, TriangleAlert, Unlink} from "lucide-react";
import Button from "@/components/ui/Button";
import type {BranchRead} from "@/lib/notes/outlineController";
import AuthoredReadFailure from "./AuthoredReadFailure";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import {ResourceTypeIcon} from "@/components/resources/ResourceType";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import {activateTargetLink} from "@/lib/panes/targetLinkActivation";
import {parseResourceRef, resourceTypeLabel} from "@/lib/resourceGraph/resourceRef";
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
  workOwners(owners: readonly string[]): void;
  editorReady(editor: TextEditorHandle | null): void;
  toggle(): void;
  select(): void;
  unlink(): void;
  reveal(): void;
}
export interface OutlineRowMount {row_id: string; leading: HTMLElement; trailing: HTMLElement; content: HTMLElement; input: TextEditorHandle | null}

export default function OutlineEditorRows({mounts, rows}: {mounts: readonly OutlineRowMount[]; rows: ReadonlyMap<string, OutlineRowChrome>}) {
  const runtime = usePaneRuntime();
  return mounts.flatMap(mount => {
    const row = rows.get(mount.row_id);
    if (!row) return [];
    const parsed = row.ref === null ? null : parseResourceRef(row.ref);
    // justify-defect: only uncommitted drafts lack a canonical resource ref.
    if (row.ref !== null && parsed === null) throw new Error(`invalid canonical resource ref: ${row.ref}`);
    const scheme = parsed === null ? "note_block" : parsed.scheme;
    const identity = resourceTypeLabel(scheme).toLowerCase();
    const marker = scheme === "note_block" ? "•" : <ResourceTypeIcon scheme={scheme}/>;
    const actions: ActionDescriptor[] = [{kind: "command", id: "Outline.SelectBlock", label: "Select item", icon: <SquareDashedMousePointer size={16} aria-hidden="true" />, restoreFocusOnClose: false, onSelect: row.select}];
    if (row.ref !== null) actions.push({kind: "command", id: "Resource.Relation.unlink", label: `Unlink from ${row.parentLabel}`, icon: <Unlink size={16} aria-hidden="true" />, restoreFocusOnClose: false, onSelect: row.unlink});
    // native keyboard traversal uses the glyph as the row's tab stop.
    const leading = <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()} onPointerCancel={event => event.stopPropagation()}
      onContextMenu={event => event.stopPropagation()}>
      <ContextualActionMenu navigation={null} title={row.label} subjectKey={`outline:${row.row_id}`} label={`relationship actions for ${row.label}`}
        sections={[{id: "Occurrence", actions}]} renderContextAnchor={context => row.href ? <a {...context}
          className={`${styles.control} ${styles.bullet}`} href={row.href} tabIndex={0} data-outline-bullet="true" data-row-focusable="true"
          aria-label={`open ${identity}: ${row.label}`} data-workspace-rich-target="true"
          onClick={event => activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}})}
          onKeyDown={event => {context.onKeyDown(event); if (!event.defaultPrevented) activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}});}}>{marker}</a>
          : <button {...context} type="button" className={`${styles.control} ${styles.bullet}`} tabIndex={0} data-outline-bullet="true"
            data-row-focusable="true" aria-label={`actions for ${identity}: ${row.label}`}>{marker}</button>}/>
    </span>;
    const trailing = row.terminal ? <button type="button" className={styles.control} data-row-focusable="true"
      aria-label={`show earlier occurrence of ${row.label}`} onKeyDown={event => event.stopPropagation()}
      onClick={event => {event.stopPropagation(); row.reveal();}}><CornerLeftUp size={14}/></button>
      : row.childrenAvailable ? <>
        <Button iconOnly type="button" className={styles.control} data-row-focusable="true"
          aria-label={`${row.open ? "collapse" : "expand"} linked resources for ${row.label}`}
          aria-expanded={row.open} aria-busy={row.read.pending}
          onKeyDown={event => event.stopPropagation()} onClick={event => {event.stopPropagation(); row.toggle();}}
          icon={row.read.error !== null ? <TriangleAlert size={14}/> : <ChevronRight size={14} className={styles.arrow} data-open={row.open || undefined}/>}/>
        <AuthoredReadFailure {...row.read} title="couldn’t open linked resources"/>
      </> : null;
    return [createPortal(leading, mount.leading, `${row.row_id}:leading`), createPortal(trailing, mount.trailing, `${row.row_id}:trailing`),
      ...(row.kind === "reference" && row.ref !== null ? [createPortal(row.resource?.kind === "highlight" ? <div contentEditable={false}><FullResourceBody item={authoredItem(row.resource)} /><HighlightAnnotation highlightRef={row.resource.ref} occurrenceKey={row.row_id} editable={!row.terminal} onWorkOwners={row.workOwners} onEditorReady={row.editorReady}/></div> : row.resource?.excerpt ? <FullResourceBody item={authoredItem(row.resource)} /> : row.label,
        mount.content, `${row.row_id}:content`)] : [])];
  });
}
