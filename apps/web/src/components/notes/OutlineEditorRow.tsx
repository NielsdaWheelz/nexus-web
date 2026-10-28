"use client";

/** Native row controls live outside ProseMirror's contentDOM. Portals publish
 * chrome into the view's stable slots; no control creates an editing host. */
import {createPortal} from "react-dom";
import {ChevronRight, CornerLeftUp} from "lucide-react";
import ContextualActionMenu from "@/components/resources/ContextualActionMenu";
import {usePaneRuntime} from "@/lib/panes/paneRuntime";
import {activateTargetLink} from "@/lib/panes/targetLinkActivation";
import {parseResourceRef, resourceTypeLabel} from "@/lib/resourceGraph/resourceRef";
import type {ActionDescriptor} from "@/lib/ui/actionDescriptor";
import styles from "./OutlineEditorRow.module.css";

export interface OutlineRowChrome {
  row_id: string;
  ref: string | null;
  kind: "note" | "title" | "reference";
  depth: number;
  parent_id: string | null;
  label: string;
  href: string | null;
  parentLabel: string;
  childrenAvailable: boolean;
  open: boolean;
  terminal: boolean;
  root: boolean;
  selected: boolean;
  toggle(): void;
  select(): void;
  unlink(): void;
  reveal(): void;
}
export interface OutlineRowMount {row_id: string; leading: HTMLElement; trailing: HTMLElement}

export default function OutlineEditorRows({mounts, rows}: {mounts: readonly OutlineRowMount[]; rows: ReadonlyMap<string, OutlineRowChrome>}) {
  const runtime = usePaneRuntime();
  return mounts.flatMap(mount => {
    const row = rows.get(mount.row_id);
    if (!row || row.root) return [];
    const parsed = row.ref && parseResourceRef(row.ref);
    const identity = parsed ? resourceTypeLabel(parsed.scheme).toLowerCase() : "note";
    const actions: ActionDescriptor[] = [{kind: "command", id: "Outline.SelectBlock", label: "Select item", restoreFocusOnClose: false, onSelect: row.select}];
    if (row.ref !== null) actions.push({kind: "command", id: "Resource.Relation.unlink", label: `unlink from ${row.parentLabel}`, restoreFocusOnClose: false, onSelect: row.unlink});
    const leading = <span onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}
      onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()}
      onPointerUp={event => event.stopPropagation()} onPointerCancel={event => event.stopPropagation()}
      onContextMenu={event => event.stopPropagation()}>
      <ContextualActionMenu title={row.label} subjectKey={`outline:${row.row_id}`} label={`relationship actions for ${row.label}`}
        sections={[{id: "Occurrence", actions}]} renderContextAnchor={context => row.href ? <a {...context}
          className={`${styles.control} ${styles.bullet}`} href={row.href} data-outline-bullet="true" data-row-focusable="true"
          aria-label={`open ${identity}: ${row.label}`} data-workspace-rich-target="true"
          onClick={event => activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}})}
          onKeyDown={event => {context.onKeyDown(event); if (!event.defaultPrevented) activateTargetLink({event, runtime, target: {href: row.href!, labelHint: row.label}});}}>•</a>
          : <button {...context} type="button" className={`${styles.control} ${styles.bullet}`} data-outline-bullet="true"
            data-row-focusable="true" aria-label={`actions for ${row.label}`}>•</button>}/>
    </span>;
    const trailing = row.terminal ? <button type="button" className={styles.control} data-row-focusable="true"
      aria-label={`show earlier occurrence of ${row.label}`} onKeyDown={event => event.stopPropagation()}
      onClick={event => {event.stopPropagation(); row.reveal();}}><CornerLeftUp size={14}/></button>
      : row.childrenAvailable ? <button type="button" className={styles.control} data-row-focusable="true"
        aria-label={`${row.open ? "collapse" : "expand"} linked resources for ${row.label}`} aria-expanded={row.open}
        onKeyDown={event => event.stopPropagation()} onClick={event => {event.stopPropagation(); row.toggle();}}>
        <ChevronRight size={14} className={styles.arrow} data-open={row.open || undefined}/>
      </button> : null;
    return [createPortal(leading, mount.leading, `${row.row_id}:leading`), createPortal(trailing, mount.trailing, `${row.row_id}:trailing`)];
  });
}
