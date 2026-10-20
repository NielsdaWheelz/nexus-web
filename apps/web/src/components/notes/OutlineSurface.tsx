"use client";

// Recursive mixed outlines share this rendering and operation boundary. Hosts
// supply real rows and destinations; the session owns every admitted mutation.
import {
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { FeedbackStatus, useFeedback } from "@/components/feedback/Feedback";
import ResourceOutlineList, {
  OutlineSessionContext,
  ResourceOutlineContext,
} from "@/components/resources/ResourceOutlineList";
import ResourceOutlineRow from "@/components/resources/ResourceOutlineRow";
import ResourceDisclosure from "@/components/resources/ResourceDisclosure";
import ReferenceRowEditor from "./ReferenceRowEditor";
import { UnavailableTexts } from "./NoteNotices";
import { hasUnsavedText, useText } from "@/lib/notes/texts";
import {
  indentParent,
  isNoteRow,
  readClipboard,
  siblingsOf,
  structuralRow,
  type Row,
} from "@/lib/notes/outline";
import type {
  DailyPublication,
  OutlineDestination,
  OutlineSession,
} from "@/lib/notes/useOutlineSession";
import {
  endpointForResource,
  type InsertionSource,
} from "@/lib/resourceGraph/links";
import { matchesPaneFilterQuery } from "@/lib/panes/paneFilterRows";
import { resolveResourceItem } from "@/lib/resources/items";
import { isApiError } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { activateResource } from "@/lib/resources/activation";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { workspaceTargetActivationIntent } from "@/lib/ui/targetActivation";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import rowStyles from "@/components/ui/ResourceRow.module.css";

type Placement = "before" | "after" | "inside";
export interface OutlineSurfaceProps {
  session: OutlineSession;
  rows: readonly Row[];
  endpoint: string;
  rootEndpoint: string;
  occurrencePrefix: string;
  path: readonly string[];
  filter?: string;
  editable?: boolean;
  historicalBranch?: boolean;
  sourceForRow?: (row: Row) => InsertionSource | null;
  publication?: DailyPublication;
  onRevealRoot?: () => void;
}

/** Clipboard access is synchronous; resource resolution cannot change the captured slot. */
export async function pasteOutline({
  session,
  destination,
  clipboard,
  publication,
}: {
  session: OutlineSession;
  destination: OutlineDestination;
  clipboard: DataTransfer;
  publication?: DailyPublication;
}): Promise<boolean> {
  const items = readClipboard(clipboard);
  if (items === null) return false;
  const refs = [
    ...new Set(
      items.flatMap((item) => (item.kind === "resource" ? [item.ref] : [])),
    ),
  ];
  const resources = Promise.all(refs.map((ref) => resolveResourceItem(ref)));
  return session.paste({
    destination,
    items,
    resources,
    publication,
  });
}

export default function OutlineSurface({
  session,
  rows,
  endpoint,
  rootEndpoint,
  occurrencePrefix,
  path,
  filter = "",
  editable = true,
  historicalBranch = false,
  sourceForRow,
  publication,
  onRevealRoot,
}: OutlineSurfaceProps) {
  const section = useRef<HTMLElement>(null);
  const feedback = useFeedback();
  const runtime = usePaneRuntime();
  const [drag, setDrag] = useState<{
    key: string;
    over: string | null;
    placement: Placement;
  } | null>(null);
  const selected =
    session.selection?.kind === "blocks" ? session.selection.keys : [];
  const selectedRows = rows.filter((row) => selected.includes(row.key));
  const ownsSelection = selectedRows.length === selected.length;
  const filtering = filter.trim() !== "";
  const committing = editable && !filtering && session.activeReference === null;
  const warn = useCallback(
    (title: string, message?: string) =>
      feedback.offer({
        key: `outline:${occurrencePrefix}`,
        announcement: "Polite",
        content: { tone: "Warning", title, message },
      }),
    [feedback, occurrencePrefix],
  );
  useLayoutEffect(() => {
    if (session.focus?.target !== "control") return;
    section.current
      ?.querySelector<HTMLElement>(
        `[data-outline-occurrence="${CSS.escape(session.focus.key)}"] [data-row-focusable]:not(:disabled)`,
      )
      ?.focus({ preventScroll: true });
  }, [session.focus]);
  useLayoutEffect(() => {
    if (
      session.selection?.kind === "blocks" &&
      session.selection.keys.some((key) => rows.some((row) => row.key === key))
    )
      section.current?.focus();
  }, [session.selection, rows]);
  const select = (key: string, extend = false) => {
    session.select({ key, rows, extend });
    window.getSelection()?.removeAllRanges();
    section.current?.focus();
  };
  const destination = (row: Row): OutlineDestination | null => {
    const source = sourceForRow
      ? sourceForRow(row)
      : endpointForResource(row.endpoint);
    const position = session.position({
      endpoint: row.endpoint,
      edgeId: row.link.link_id,
      side: "after",
    });
    return source && position
      ? {
          source,
          position,
          occurrencePrefix: row.occurrencePrefix,
          path: row.path.slice(0, -1),
        }
      : null;
  };
  const onBlockKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== section.current || session.activeReference !== null)
      return;
    const mac = navigator.platform.toLowerCase().includes("mac");
    const mod = mac ? event.metaKey : event.ctrlKey;
    const key = event.key;
    if (
      (mod && key.toLowerCase() === "z") ||
      (!mac && event.ctrlKey && key.toLowerCase() === "y")
    ) {
      event.preventDefault();
      if (committing)
        (event.shiftKey || key.toLowerCase() === "y"
          ? session.redo
          : session.undo)();
      return;
    }
    const row = rows.find((candidate) => candidate.key === selected.at(-1));
    if (!row) return;
    if (key === "Escape") {
      event.preventDefault();
      session.clearSelection();
      return;
    }
    if (key === "Enter") {
      const intent = workspaceTargetActivationIntent(event, "activate");
      if (intent.kind === "Unowned") return;
      event.preventDefault();
      if (row.terminal) session.reveal(row.terminal);
      else if (isNoteRow(row)) session.focusRow(row.key);
      else if (intent.kind === "Open" && runtime)
        activateResource(row.link.target.item.activation, {
          labelHint: row.link.target.item.label,
          disposition: {
            kind: intent.intent === "new_pane" ? "Fork" : "Follow",
          },
          activateTarget: runtime.activateTarget,
        });
      return;
    }
    if (key === "ArrowUp" || key === "ArrowDown") {
      event.preventDefault();
      const direction = key === "ArrowUp" ? -1 : 1;
      if (committing && event.shiftKey && (mac ? event.metaKey : event.altKey))
        session.move({ row, rows, direction });
      else {
        const next = rows[rows.indexOf(row) + direction];
        if (next)
          session.select({ key: next.key, rows, extend: event.shiftKey });
      }
      return;
    }
    if (
      committing &&
      (key === "Backspace" || key === "Delete") &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.repeat &&
      !event.nativeEvent.isComposing &&
      event.nativeEvent.keyCode !== 229
    ) {
      event.preventDefault();
      if (ownsSelection) session.unlinkOccurrences(selectedRows);
      else warn("selection changed; select the current links again");
    }
  };
  const directRows = rows.filter(
    (row) =>
      row.path.length === path.length + 1 &&
      row.path.slice(0, -1).every((id, i) => id === path[i]),
  );
  return (
    <OutlineSessionContext value={session}>
      <section
        ref={section}
        className={rowStyles.outlineGeometry}
        aria-label="Linked notes"
        tabIndex={-1}
        onKeyDown={onBlockKey}
        onFocus={(event) => {
          if (selected.length && event.target.isContentEditable)
            session.clearSelection();
        }}
        onCopy={(event) => {
          if (
            event.target === section.current &&
            selected.length &&
            ownsSelection
          ) {
            event.preventDefault();
            session.copy({
              rows: selectedRows,
              clipboard: event.clipboardData,
              cut: false,
            });
          }
        }}
        onCut={(event) => {
          if (
            event.target === section.current &&
            committing &&
            selected.length &&
            ownsSelection
          ) {
            event.preventDefault();
            session.copy({
              rows: selectedRows,
              clipboard: event.clipboardData,
              cut: true,
            });
          }
        }}
        onPaste={(event) => {
          if (
            event.target !== section.current ||
            !committing ||
            !selected.length
          )
            return;
          const row = rows.find(
            (candidate) => candidate.key === selected.at(-1),
          );
          const target = row ? destination(row) : null;
          if (!target) return;
          event.preventDefault();
          void pasteOutline({
            session,
            destination: target,
            clipboard: event.clipboardData,
            publication,
          }).then(
            (applied) => {
              if (!applied) warn("paste not applied");
            },
            (error: unknown) => {
              if (handleUnauthenticatedApiError(error)) return;
              if (
                !(error instanceof TypeError || error instanceof SyntaxError) &&
                !isApiError(error)
              )
                throw error;
              warn("paste not applied", error.message);
            },
          );
        }}
      >
        {committing && selected.length ? (
          <FeedbackStatus
            announcement="Polite"
            content={{
              tone: "Neutral",
              title:
                "link selected. backspace or delete removes the connection; notes remain.",
            }}
          />
        ) : null}
        <ResourceOutlineList
          scope={occurrencePrefix}
          ariaLabel="Note items"
          ancestorRef={endpoint}
          viewLocked={session.activeReference !== null}
          onRevealRoot={onRevealRoot}
        >
          {directRows.map((row) => (
            <SurfaceRow
              key={row.key}
              row={row}
              rows={rows}
              session={session}
              rootEndpoint={rootEndpoint}
              destination={destination(row)}
              editable={editable && !filtering}
              historicalBranch={historicalBranch}
              hidden={
                filtering &&
                !matchesPaneFilterQuery(filter, [
                  row.link.target.content.kind === "note"
                    ? row.link.target.content.body_text
                    : row.link.target.item.label,
                ])
              }
              selected={selected.includes(row.key)}
              onSelect={(extend) => select(row.key, extend)}
              publication={publication}
              drop={drag?.over === row.key ? drag.placement : null}
              onDragStart={() =>
                setDrag({ key: row.key, over: null, placement: "after" })
              }
              onDragOver={(placement) => {
                if (drag && drag.key !== row.key)
                  setDrag({ ...drag, over: row.key, placement });
              }}
              onDragEnd={() => setDrag(null)}
              onDrop={() => {
                const source = rows.find(
                  (candidate) => candidate.key === drag?.key,
                );
                const handled = source !== undefined && drag?.over === row.key;
                if (handled)
                  session.drop({
                    row: source,
                    target: row,
                    placement: drag.placement,
                  });
                setDrag(null);
                return handled;
              }}
              warn={warn}
            />
          ))}
        </ResourceOutlineList>
      </section>
    </OutlineSessionContext>
  );
}

function SurfaceRow({
  row,
  rows,
  session,
  rootEndpoint,
  destination,
  editable,
  historicalBranch,
  hidden,
  selected,
  onSelect,
  publication,
  drop,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
  warn,
}: {
  row: Row;
  rows: readonly Row[];
  session: OutlineSession;
  rootEndpoint: string;
  destination: OutlineDestination | null;
  editable: boolean;
  historicalBranch: boolean;
  hidden: boolean;
  selected: boolean;
  onSelect(extend: boolean): void;
  publication?: DailyPublication;
  drop: Placement | null;
  onDragStart(): void;
  onDragOver(value: Placement): void;
  onDragEnd(): void;
  onDrop(): boolean;
  warn(title: string, message?: string): void;
}) {
  const outlineView = useContext(ResourceOutlineContext);
  const text = useText(row.link.target.item.ref);
  const node = row.link.target;
  const historical =
    node.content.kind === "resource" &&
    row.link.connection !== null &&
    row.link.connection.ordinal !== null;
  const terminal = row.terminal !== null;
  const pending = session.pendingUnlinks.has(row.link.link_id);
  const placement = session.placement(row);
  const movable =
    editable &&
    placement !== null &&
    !pending &&
    !terminal &&
    session.activeReference === null;
  const indentTarget = movable ? indentParent(rows, row) : null;
  const siblings = siblingsOf(rows, row),
    index = siblings.indexOf(row);
  const action = (
    id: string,
    label: string,
    onSelect: () => void,
  ): Extract<ActionDescriptor, { kind: "command" }> => ({
    kind: "command",
    id: `Outline.${id}`,
    label,
    onSelect,
  });
  const childSource = !historical && !node.item.missing
    ? endpointForResource(node.item.ref) : null;
  const resourceActions: ActionDescriptor[] = editable && !terminal && childSource
    ? [action("AddItem", "add item", () => {
        if (session.activeReference !== null) return;
        session.toggle({ key: row.key, open: true });
        void session.insertNote({ destination: {
          source: childSource, position: null,
          occurrencePrefix: row.occurrencePrefix, path: row.path,
        } });
      })] : [];
  const actions: ActionDescriptor[] = [...resourceActions];
  if (!terminal)
    actions.push(action("Select", "select block", () => onSelect(false)));
  if (movable && indentParent(rows, row))
    actions.push(
      action("Indent", "indent link", () => session.indent({ row, rows })),
    );
  if (movable && row.path.length > 1)
    actions.push(
      action("Outdent", "outdent link", () =>
        session.outdent({ row, rootEndpoint }),
      ),
    );
  if (movable && index > 0)
    actions.push(
      action("Earlier", "move link earlier", () =>
        session.move({ row, rows, direction: -1 }),
      ),
    );
  if (movable && index < siblings.length - 1)
    actions.push(
      action("Later", "move link later", () =>
        session.move({ row, rows, direction: 1 }),
      ),
    );
  const userUnlinkAction = row.link.connection?.origin === "user" &&
    row.link.connection.mutation?.kind === "unlink" &&
    ((editable && session.canUnlink(row)) || pending)
    ? { ...action("RemoveLink", pending ? "removing link…" : "remove link from both items; keep their notes",
        () => session.unlinkOccurrences([row])),
        disabled: pending, disabledReason: pending ? "removing link…" : undefined,
        restoreFocusOnClose: false }
    : null;
  if (
    row.noteAuthority !== null &&
    text?.gone &&
    hasUnsavedText(node.item.ref)
  )
    return (
      <li>
        <UnavailableTexts kind="note" refs={[node.item.ref]} />
      </li>
    );
  return (
    <ResourceOutlineRow
      incoming={{ kind: "edge", edge_id: row.link.link_id,
        origin: row.link.connection?.origin ?? "user",
        mutation: row.link.connection?.mutation ?? null,
        creation: row.link.connection?.creation ?? null }}
      item={node.item}
      occurrenceKey={row.key}
      connection={row.link.connection ?? undefined}
      edgeId={row.link.link_id}
      noteAuthority={row.noteAuthority ?? undefined}
      noteEditable={editable && !pending}
      notePublication={publication}
      noteEmbeddedItem={
        node.content.kind === "note" ? node.content.embedded_item : null
      }
      noteKeys={
        !terminal && editable
          ? {
              selectBlock: () => onSelect(false),
              ...(movable && indentTarget
                ? { indent: () => session.indent({ row, rows }) }
                : {}),
              ...(movable && row.path.length > 1
                ? { outdent: () => session.outdent({ row, rootEndpoint }) }
                : {}),
              ...(structuralRow(row)
                ? {
                    emptyBackspace: () => session.consume(row),
                    join: (direction) => session.join({ row, rows, direction }),
                  }
                : {}),
            }
          : undefined
      }
      indentDestination={
        indentTarget
          ? {
              source: {
                kind: "resource",
                ref: indentTarget.link.target.item.ref,
              },
              position: null,
              occurrencePrefix: indentTarget.occurrencePrefix,
              path: indentTarget.path,
            }
          : null
      }
      historical={historical}
      historicalBranch={historicalBranch}
      continuation={editable ? destination : null}
      authoredPlacement={placement}
      resourceActions={resourceActions}
      occurrenceActions={actions}
      userUnlinkAction={userUnlinkAction}
      presentation={
        row.noteAuthority !== null && !terminal ? "inline_note" : undefined
      }
      rootProps={{
        hidden,
        "data-selected": selected,
        "data-drop": drop ?? undefined,
        onDragOver: (event) => {
          if (!editable) return;
          event.preventDefault();
          event.stopPropagation();
          const bounds = event.currentTarget.getBoundingClientRect();
          const y = (event.clientY - bounds.top) / bounds.height;
          onDragOver(y < 0.25 ? "before" : y > 0.75 ? "after" : "inside");
        },
        onDrop: (event) => {
          event.preventDefault();
          event.stopPropagation();
          const moving = outlineView?.placementDrag.current;
          const handled = onDrop();
          if (!handled && moving && moving.link_id !== row.link.link_id) {
            const bounds = event.currentTarget.getBoundingClientRect();
            const y = (event.clientY - bounds.top) / bounds.height;
            const inside = y >= 0.25 && y <= 0.75;
            const source = endpointForResource(
              inside ? node.item.ref : row.endpoint,
            );
            const position = inside
              ? null
              : session.position({
                  endpoint: row.endpoint,
                  edgeId: row.link.link_id,
                  side: y < 0.25 ? "before" : "after",
                });
            if (source?.kind === "resource" && (inside || position !== null)) {
              const target = {
                source,
                position,
                occurrencePrefix: row.occurrencePrefix,
                path: inside ? row.path : row.path.slice(0, -1),
              };
              if (moving.endpoint === source.ref && position !== null)
                session.movePlacement({
                  placement: moving,
                  destination: target,
                });
              else
                session.relinkPlacement({
                  placement: moving,
                  destination: target,
                });
              if (inside) session.toggle({ key: row.key, open: true });
            }
          }
          if (outlineView) outlineView.placementDrag.current = null;
        },
      }}
      bulletProps={{
        draggable: movable,
        onDragStart: (event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", row.key);
          onDragStart();
        },
        onDragEnd,
      }}
      body={
        row.noteAuthority === null && editable && !terminal && destination ? (
          <ReferenceRowEditor
            item={node.item}
            occurrenceKey={row.key}
            focusSerial={
              session.focus?.key === row.key &&
              session.focus.target === "reference"
                ? session.focus.serial
                : null
            }
            editable={
              !pending &&
              (session.activeReference === null ||
                session.activeReference === row.key)
            }
            reference={{
              source: destination.source,
              label: node.item.label,
              position:
                destination.position?.expected_links_version === null
                  ? null
                  : destination.position,
              onSelected: (target) => {
                void session.insertReference({
                  destination,
                  target,
                  ...(publication ? { publication } : {}),
                });
              },
              onActiveChange: (active) =>
                session.setReferenceActive(row.key, active),
            }}
            onInsert={async (body) =>
              (await session.insertNote({
                destination,
                body,
                ...(publication ? { publication } : {}),
              })) !== null
            }
            onIndent={
              movable && indentParent(rows, row)
                ? () => session.indent({ row, rows })
                : undefined
            }
            onPaste={async (clipboard) => {
              try {
                if (clipboard.files.length)
                  throw new TypeError("paste attachments into a note body");
                return await pasteOutline({
                  session,
                  destination,
                  clipboard,
                  publication,
                });
              } catch (error) {
                if (handleUnauthenticatedApiError(error)) return false;
                if (
                  !(
                    error instanceof TypeError || error instanceof SyntaxError
                  ) &&
                  !isApiError(error)
                )
                  throw error;
                warn("paste not applied", error.message);
                return false;
              }
            }}
            onSelect={onSelect}
            onCopy={(clipboard, cut) => {
              session.copy({ rows: [row], clipboard, cut });
              return true;
            }}
            history={{
              undo: session.undo,
              redo: session.redo,
              boundary: session.boundary,
            }}
          />
        ) : undefined
      }
      placement={{
        expanded: row.open,
        toggle: () => session.toggle({ key: row.key, open: !row.open }),
        children: (
          <ResourceDisclosure
            resourceRef={node.item.ref}
            occurrencePrefix={row.occurrencePrefix}
            path={row.path}
            rootEndpoint={rootEndpoint}
            readOnly={!editable}
            historicalBranch={historicalBranch || historical}
            suppressedEdgeIds={
              node.item.preview.annotation
                ? [node.item.preview.annotation.attachment_edge_id]
                : []
            }
          />
        ),
      }}
      resourceDetails={
        pending ? (
          <FeedbackStatus
            announcement="None"
            content={{ tone: "Neutral", title: "removing link…" }}
          />
        ) : undefined
      }
    />
  );
}
