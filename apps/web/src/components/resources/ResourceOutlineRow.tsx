"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type AnchorHTMLAttributes,
  type ReactNode,
  type Ref,
} from "react";
import { ChevronRight, CornerLeftUp } from "lucide-react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import AnnotationNoteHost from "@/components/notes/AnnotationNoteHost";
import CanonicalNoteEditor from "@/components/notes/CanonicalNoteEditor";
import type { StructuralKeys } from "@/components/notes/NoteEditor";
import ReferenceRowEditor from "@/components/notes/ReferenceRowEditor";
import { resourceOccurrenceKey } from "@/lib/notes/outline";
import { fetchNote } from "@/lib/notes/api";
import { adoptText, useText } from "@/lib/notes/texts";
import type {
  DailyPublication,
  OutlineDestination,
  OutlinePlacement,
  OutlineSession,
} from "@/lib/notes/useOutlineSession";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import MachineText from "@/components/ui/MachineText";
import { isApiError } from "@/lib/api/client";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import {
  connectionMutationErrorMessage,
  endpointForResource,
  mutateConnection,
  type ConnectionMutation,
  type ConnectionOut,
  type InsertionSource,
} from "@/lib/resourceGraph/links";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import {
  classifyOutlineOccurrence,
  enterOutlineOccurrence,
  type OutlineBranch,
} from "@/lib/resources/outlineProjection";
import {
  resourceMetadata,
  type ResourcePresentation,
} from "@/lib/resources/metadata";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";
import { cx } from "@/lib/ui/cx";
import ContextualActionMenu from "./ContextualActionMenu";
import ResourceBody, {
  ResourceMatchEvidence,
  type ResourceMatch,
} from "./ResourceBody";
import ResourceMetadata from "./ResourceMetadata";
import {
  OutlineSessionContext,
  ResourceBranch,
  ResourceOutlineContext,
} from "./ResourceOutlineList";
import ResourceRow from "@/components/ui/ResourceRow";
import ResourceDisclosure from "./ResourceDisclosure";
import { pasteOutline } from "@/components/notes/OutlineSurface";
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
 * internal placement drops belong to the nearest actual row before nested editors;
 * external text and files remain editor-owned.
 * supplied actions replace the default resource menu. */
export default function ResourceOutlineRow({
  item,
  occurrenceKey,
  presentation,
  connection,
  edgeId,
  representedEdgeIds = [],
  embeddedInNoteRef = null,
  mutationEdgeId,
  contextMutation,
  resourceActions = [],
  occurrenceActions = [],
  occurrenceLabel,
  onChanged,
  onFocusBranch,
  primaryLinkRef,
  match,
  matchMethod,
  body,
  sourceContent,
  creation,
  resourceDetails,
  nestedContent,
  details,
  primaryControl,
  actions,
  placement,
  rootProps,
  bulletProps,
  rowRef,
  historical = false,
  historicalBranch = false,
  continuation: suppliedContinuation,
  insertionSource,
  authoredPlacement = null,
  noteAuthority,
  noteEditable = true,
  noteKeys,
  notePublication,
  noteEmbeddedItem = null,
  indentDestination = null,
  annotationFocusRequest = null,
  onAnnotationClose,
}: {
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
  sourceContent?: ReactNode;
  resourceDetails?: ReactNode;
  nestedContent?: ReactNode;
  details?: ReactNode;
  primaryControl?: ReactNode;
  creation?: Schema<"ConnectionCreationOut"> | null;
  actions?: ReactNode;
  placement?: PlacementBranch;
  rootProps?: HTMLAttributes<HTMLElement> & {
    "data-active"?: boolean;
    "data-selected"?: boolean;
    "data-drop"?: string;
  };
  bulletProps?: AnchorHTMLAttributes<HTMLAnchorElement>;
  rowRef?: Ref<HTMLLIElement>;
  historical?: boolean;
  historicalBranch?: boolean;
  continuation?: OutlineDestination | null;
  insertionSource?: InsertionSource | null;
  authoredPlacement?: OutlinePlacement | null;
  noteAuthority?: "current" | "local";
  noteEditable?: boolean;
  noteKeys?: StructuralKeys;
  notePublication?: DailyPublication;
  noteEmbeddedItem?: Item | null;
  indentDestination?: OutlineDestination | null;
  annotationFocusRequest?: number | null;
  onAnnotationClose?: () => void;
}) {
  const runtime = usePaneRuntime();
  const session = useContext(OutlineSessionContext);
  const outline = useContext(ResourceOutlineContext);
  const disclosureDisabled =
    (outline?.viewLocked ?? false) ||
    (session?.activeReference !== null &&
      session?.activeReference !== undefined);
  const inherited = useContext(ResourceBranch);
  const focus = outline?.view.focused ?? null;
  const focusedRoot = focus === occurrenceKey;
  const branch = useMemo<OutlineBranch>(
    () =>
      focusedRoot
        ? { ancestors: new Map(), traversedEdgeIds: new Set() }
        : inherited,
    [focusedRoot, inherited],
  );
  const enteringEdgeId = edgeId ?? connection?.edge_id ?? null;
  const projection = classifyOutlineOccurrence({
    branch,
    targetRef: item.ref,
    edgeId: focusedRoot ? null : enteringEdgeId,
  });
  const terminal = projection.kind === "reference";
  const childrenBranch = useMemo(
    () =>
      enterOutlineOccurrence({
        branch,
        ref: item.ref,
        target: focusedRoot
          ? { kind: "root" }
          : { kind: "occurrence", key: occurrenceKey },
        edgeIds: focusedRoot
          ? []
          : [
              ...representedEdgeIds,
              ...(enteringEdgeId === null ? [] : [enteringEdgeId]),
            ],
      }),
    [
      branch,
      enteringEdgeId,
      focusedRoot,
      item.ref,
      occurrenceKey,
      representedEdgeIds,
    ],
  );
  const [localOpen, setLocalOpen] = useState(false);
  const annotationEdit = useResourceDraft(
    `Annotations.Active:${occurrenceKey}`,
    () => false,
  );
  const [annotationActivation, setAnnotationActivation] = useState<
    number | null
  >(null);
  const activationSerial = useRef(0);
  const activateAnnotation = () => {
    const activeReference = session?.activeReference;
    const annotationRef = item.preview.annotation?.note_ref;
    if (
      activeReference != null &&
      (!annotationRef ||
        activeReference !==
          resourceOccurrenceKey(`${occurrenceKey}/annotation`, annotationRef))
    )
      return;
    if (!annotationEdit.value && annotationFocusRequest === null)
      setAnnotationActivation(++activationSerial.current);
    annotationEdit.set(true);
  };
  const defaultSource =
    historical || item.missing
      ? null
      : insertionSource === undefined
        ? endpointForResource(item.ref)
        : insertionSource;
  const continuation =
    suppliedContinuation === undefined
      ? defaultSource
        ? {
            source: defaultSource,
            position: null,
            occurrencePrefix: occurrenceKey,
            path: [],
          }
        : null
      : suppliedContinuation;
  const indentTarget =
    indentDestination?.source.kind === "resource"
      ? {
          ...indentDestination,
          source: indentDestination.source,
        }
      : null;
  const linkNote = useResourceDraft(
    `Annotations.LinkEditor:${occurrenceKey}`,
    () => false,
  );
  const [noteFocusRequest, setNoteFocusRequest] = useState(0);
  const canEditLinkNote =
    connection?.origin === "user" &&
    connection.kind === "context" &&
    connection.mutation?.kind === "unlink";
  const open =
    projection.kind === "resource" &&
    (placement?.expanded ??
      outline?.view.folds.get(occurrenceKey) ??
      localOpen);
  const focusKey = session?.focus?.key;
  const openBranch = session?.toggle;
  useLayoutEffect(() => {
    if (
      !open &&
      !terminal &&
      focusKey?.startsWith(`${occurrenceKey}/`) &&
      !focusKey.startsWith(`${occurrenceKey}/annotation/`)
    ) {
      if (openBranch) openBranch({ key: occurrenceKey, open: true });
      else setLocalOpen(true);
    }
  }, [focusKey, occurrenceKey, open, openBranch, terminal]);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const submitted = useRef<{
    edgeId: string;
    mutation: ConnectionMutation;
  } | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const element = useRef<HTMLLIElement | null>(null);
  const focusedRowRemoved = outline?.focusedRowRemoved;
  const attachRow = useCallback(
    (node: HTMLLIElement | null) => {
      const previous = element.current;
      element.current = node;
      if (typeof rowRef === "function") rowRef(node);
      else if (rowRef) rowRef.current = node;
      if (node === null && previous !== null && focusedRoot)
        focusedRowRemoved?.(occurrenceKey, previous);
    },
    [focusedRoot, focusedRowRemoved, occurrenceKey, rowRef],
  );
  const arrow = useRef<HTMLButtonElement | null>(null);
  const childrenId = useId();
  const mutation = focusedRoot
    ? null
    : (connection?.mutation ?? contextMutation);
  const activation = item.activation;
  const bodyKind = item.preview.body;
  const reason =
    connection && !focusedRoot
      ? `${connection.kind === "context" ? "" : `${connection.kind} · `}${connectionReason(connection, historicalBranch || historical)}`
      : null;
  const metadata = resourceMetadata({
    item,
    matchMethod,
    presentation,
    occurrenceLabel: focusedRoot ? undefined : occurrenceLabel,
    reason,
  });
  const unavailable =
    activation.unavailable_reason === "location_unavailable"
      ? "quoted location unavailable"
      : activation.unavailable_reason === "source_unavailable"
        ? "source unavailable"
        : null;
  const focusPath = focus !== null && focus.startsWith(`${occurrenceKey}/`);
  const outsideFocus =
    focus !== null &&
    !focusPath &&
    focus !== occurrenceKey &&
    !occurrenceKey.startsWith(`${focus}/`);

  function toggle() {
    if (disclosureDisabled) return;
    if (open && element.current?.contains(document.activeElement))
      arrow.current?.focus({ preventScroll: true });
    if (placement) placement.toggle();
    else if (outline) outline.toggle(occurrenceKey, !open);
    else setLocalOpen(!open);
  }

  function focusBranch() {
    if (disclosureDisabled) return;
    if (onFocusBranch) {
      onFocusBranch();
      return;
    }
    if (!open) toggle();
    outline?.focus(occurrenceKey);
  }

  async function mutate(retry = false) {
    if (!mutation || busyRef.current) return;
    const command = retry
      ? submitted.current
      : { edgeId: enteringEdgeId ?? mutationEdgeId ?? item.ref, mutation };
    if (!command) return;
    submitted.current = command;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    setRefreshRequired(false);
    const row = element.current;
    const neighbours = [
      row?.nextElementSibling,
      row?.previousElementSibling,
      row?.parentElement?.closest("li"),
      row?.parentElement,
    ].flatMap((node) =>
      node
        ? [
            node.querySelector<HTMLElement>(
              "[data-row-focusable]:not(:disabled)",
            ) ?? (node as HTMLElement),
          ]
        : [],
    );
    let ownsFocus = true;
    const release = () => {
      ownsFocus = false;
    };
    document.addEventListener("pointerdown", release, true);
    document.addEventListener("keydown", release, true);
    try {
      await mutateConnection(command.edgeId, command.mutation);
      submitted.current = null;
      onChanged?.();
      if (
        ownsFocus &&
        (row?.contains(document.activeElement) ||
          document.activeElement === document.body)
      )
        neighbours
          .find((node) => node.isConnected)
          ?.focus({ preventScroll: true });
    } catch (error) {
      if (!handleUnauthenticatedApiError(error)) {
        try {
          setFailure(connectionMutationErrorMessage(error));
          if (isApiError(error) && error.code === "E_CONTEXT_CHANGED") {
            submitted.current = null;
            setRefreshRequired(true);
          }
        } catch (error) {
          setDefect({ error });
        }
      }
    } finally {
      document.removeEventListener("pointerdown", release, true);
      document.removeEventListener("keydown", release, true);
      busyRef.current = false;
      setBusy(false);
    }
  }

  const primaryBody =
    body ??
    (noteAuthority && !historical && session ? (
      <LiveNoteBody
        item={item}
        occurrenceKey={occurrenceKey}
        authority={noteAuthority}
        editable={noteEditable}
        inline={presentation === "inline_note"}
        structuralKeys={noteKeys}
        publication={notePublication}
        embeddedItem={noteEmbeddedItem}
        terminal={terminal}
        continuation={continuation}
        session={session}
        indent={
          authoredPlacement && indentTarget
            ? () =>
                session.relinkPlacement({
                  placement: authoredPlacement,
                  destination: indentTarget,
                })
            : undefined
        }
      />
    ) : continuation && session && !terminal && !historical ? (
      <ReferenceRowEditor
        item={item}
        occurrenceKey={occurrenceKey}
        label={`${continuation.position === null ? "continue under" : "continue after"} ${item.label}`}
        focusSerial={
          session.focus?.key === occurrenceKey &&
          session.focus.target === "reference"
            ? session.focus.serial
            : null
        }
        reference={{
          source: continuation.source,
          position:
            continuation.position?.expected_links_version === null
              ? null
              : continuation.position,
          label: item.label,
          onSelected: (target) => {
            void session.insertReference({ destination: continuation, target });
          },
          onActiveChange: (active) =>
            session.setReferenceActive(occurrenceKey, active),
        }}
        editable={
          session.activeReference === null ||
          session.activeReference === occurrenceKey
        }
        onInsert={async (next) =>
          (await session.insertNote({
            destination: continuation,
            body: next,
          })) !== null
        }
        onIndent={
          authoredPlacement && indentTarget
            ? () =>
                session.relinkPlacement({
                  placement: authoredPlacement,
                  destination: indentTarget,
                })
            : undefined
        }
        onPaste={async (clipboard) => {
          try {
            return await pasteOutline({
              session,
              destination: continuation,
              clipboard,
            });
          } catch (error) {
            if (handleUnauthenticatedApiError(error)) return false;
            if (
              !isApiError(error) &&
              !(error instanceof TypeError || error instanceof SyntaxError)
            )
              throw error;
            setFailure({
              tone: "Warning",
              title: "paste not applied",
              message: error.message,
            });
            return false;
          }
        }}
        history={{
          undo: session.undo,
          redo: session.redo,
          boundary: session.boundary,
        }}
      />
    ) : undefined);
  const commands: ActionDescriptor[] = [
    ...resourceActions,
    ...(focusedRoot ? [] : occurrenceActions),
  ];
  if (defaultSource && !terminal)
    commands.unshift({
      kind: "command",
      id: "Resource.AddItem",
      label: item.ref.startsWith("highlight:")
        ? "add item to highlight"
        : "add item",
      onSelect: () => {
        if (session?.activeReference != null) return;
        if (!open) toggle();
        if (session)
          void session.insertNote({
            destination: {
              source: defaultSource,
              position: null,
              occurrencePrefix: occurrenceKey,
              path: [],
            },
          });
      },
    });
  if (activation.kind === "route" && activation.href && runtime)
    commands.push({
      kind: "command",
      id: "OpenInNewPane",
      label: "open in new pane",
      onSelect: () =>
        runtime.activateTarget({
          target: { href: activation.href!, labelHint: item.label },
          disposition: { kind: "Fork" },
        }),
    });
  if (activation.href)
    commands.unshift({
      kind: "link",
      id: "Open",
      label: "open",
      href: activation.href,
    });
  if (outline && !terminal && !focusedRoot)
    commands.push({
      kind: "command",
      id: "Resource.FocusBranch",
      label: "focus this branch",
      disabled: disclosureDisabled,
      disabledReason: disclosureDisabled ? "finish linking first" : undefined,
      onSelect: focusBranch,
    });
  const made = focusedRoot ? null : (creation ?? connection?.creation);
  if (made)
    commands.push({
      kind: "link",
      id: "Resource.Creation",
      label: "view creation",
      href:
        made.conversation_id && made.message_id
          ? `/conversations/${made.conversation_id}?message=${made.message_id}`
          : `/settings/account?generation_id=${made.generation_id}&tool_call_id=${made.tool_call_id}#assistant-writes`,
    });
  if (!focusedRoot && canEditLinkNote)
    commands.push({
      kind: "command",
      id: "Resource.LinkNote",
      label: connection.link_note ? "edit note on link" : "add note on link",
      restoreFocusOnClose: false,
      onSelect: () => {
        if (!canEditLinkNote) return;
        linkNote.set(true);
        setNoteFocusRequest((value) => value + 1);
      },
    });
  const annotation = item.preview.annotation;
  const showSequenceLabels =
    annotation !== null &&
    session !== null &&
    (session
      .outline(annotation.note_ref)
      ?.links.some((link) => link.link_id !== annotation.attachment_edge_id) ??
      false) &&
    (session
      .outline(item.ref)
      ?.links.some((link) => link.link_id !== annotation.attachment_edge_id) ??
      false);
  if (annotation?.activation.href)
    commands.push({
      kind: "link",
      id: "Resource.OpenAnnotation",
      label: "edit annotation",
      href: annotation.activation.href,
    });
  if (mutation)
    commands.push({
      kind: "command",
      id: `Resource.Relation.${mutation.kind}`,
      label: busy ? "working…" : MUTATION_LABEL[mutation.kind],
      disabled: busy,
      disabledReason: busy ? "working…" : undefined,
      restoreFocusOnClose: false,
      onSelect: () => void mutate(),
    });
  if (
    !historical &&
    item.ref.startsWith("highlight:") &&
    !annotation &&
    !terminal
  )
    commands.unshift({
      kind: "command",
      id: "Resource.AddAnnotation",
      label: "add note",
      onSelect: activateAnnotation,
    });
  const boundCommands = commands.map((action) =>
    action.kind === "command" && session?.activeReference != null
      ? {
          ...action,
          disabled: true,
          disabledReason: "finish linking or return to prose first",
        }
      : action.kind === "link" && !action.onActivate
        ? {
            ...action,
            onActivate: (event: TargetActivationEvent) =>
              activateTargetLink({
                event,
                runtime,
                target: { href: action.href },
              }),
          }
        : action,
  );
  if (defect) throw defect.error;
  if (projection.kind === "omit") return null;
  return (
    <ResourceBranch value={childrenBranch}>
      <ResourceRow
        primary={{ kind: "static" }}
        title={null}
        rowRef={attachRow}
        rootProps={{
          ...rootProps,
          onDragOver: (event) => {
            rootProps?.onDragOver?.(event);
            if (
              outline?.placementDrag.current &&
              defaultSource?.kind === "resource" &&
              !historical &&
              !terminal
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          },
          onDropCapture: (event) => {
            rootProps?.onDropCapture?.(event);
            const moving = outline?.placementDrag.current;
            if (
              !moving ||
              !(event.target instanceof Element) ||
              event.target.closest("[data-collection-row-id]") !==
                event.currentTarget
            )
              return;
            // Placement drops belong to the nearest row before a nested editor
            // can interpret the dragged bullet as new prose.
            event.preventDefault();
            event.stopPropagation();
            if (rootProps?.onDrop) {
              rootProps.onDrop(event);
              return;
            }
            if (
              !session ||
              defaultSource?.kind !== "resource" ||
              historical ||
              terminal
            )
              return;
            session.relinkPlacement({
              placement: moving,
              destination: {
                source: defaultSource,
                position: null,
                occurrencePrefix: occurrenceKey,
                path: [],
              },
            });
            if (outline) outline.placementDrag.current = null;
            if (!open) toggle();
          },
          hidden: rootProps?.hidden || outsideFocus,
          "data-outline-occurrence": occurrenceKey,
          "data-collection-row-id": occurrenceKey,
          "data-resource-ref": item.ref,
          "data-focus-path": focusPath || undefined,
          "data-outline-focused-root": focusedRoot || undefined,
        }}
        outline={{
          controls: (
            <>
              {projection.kind === "reference" ? (
                <button
                  ref={arrow}
                  type="button"
                  className={styles.control}
                  disabled={disclosureDisabled}
                  aria-label={`show earlier occurrence of ${item.label}`}
                  title={`show earlier occurrence of ${item.label}`}
                  onClick={() => outline?.reveal(projection.target)}
                  data-row-focusable="true"
                >
                  <CornerLeftUp size={14} aria-hidden="true" />
                </button>
              ) : (
                <button
                  ref={arrow}
                  type="button"
                  className={styles.control}
                  aria-label={`Expand linked resources for ${item.label}`}
                  aria-expanded={open}
                  aria-controls={open ? childrenId : undefined}
                  disabled={item.missing || disclosureDisabled}
                  onClick={toggle}
                  data-row-focusable="true"
                >
                  <ChevronRight
                    size={14}
                    className={styles.arrow}
                    data-open={open || undefined}
                    aria-hidden="true"
                  />
                </button>
              )}
              {activation.href ? (
                <a
                  {...bulletProps}
                  draggable={
                    bulletProps?.draggable ?? authoredPlacement !== null
                  }
                  onDragStart={(event) => {
                    if (authoredPlacement && outline)
                      outline.placementDrag.current = authoredPlacement;
                    bulletProps?.onDragStart?.(event);
                  }}
                  onDragEnd={(event) => {
                    if (outline) outline.placementDrag.current = null;
                    bulletProps?.onDragEnd?.(event);
                  }}
                  className={cx(styles.control, styles.bullet)}
                  href={activation.href}
                  aria-label={`open ${metadata.identity}: ${item.label}`}
                  data-workspace-rich-target="true"
                  data-row-focusable="true"
                  onClick={(event) =>
                    activateTargetLink({
                      event,
                      runtime,
                      target: activation.href
                        ? { href: activation.href, labelHint: item.label }
                        : null,
                    })
                  }
                  onKeyDown={(event) =>
                    activateTargetLink({
                      event,
                      runtime,
                      target: activation.href
                        ? { href: activation.href, labelHint: item.label }
                        : null,
                    })
                  }
                >
                  •
                </a>
              ) : (
                <span
                  className={cx(styles.control, styles.bullet)}
                  aria-label={unavailable ?? "resource unavailable"}
                  aria-disabled="true"
                >
                  •
                </span>
              )}
            </>
          ),
          body: (
            <div className={styles.content}>
              {primaryBody ?? (
                <div className={styles.primary}>
                  <div className={styles.primaryText}>
                    {activation.href ? (
                      <a
                        ref={primaryLinkRef}
                        className={styles.primaryLink}
                        href={activation.href}
                        aria-label={`open ${item.label}`}
                        data-workspace-rich-target="true"
                        data-row-focusable="true"
                        onClick={(event) =>
                          activateTargetLink({
                            event,
                            runtime,
                            target: activation.href
                              ? { href: activation.href, labelHint: item.label }
                              : null,
                          })
                        }
                        onKeyDown={(event) =>
                          activateTargetLink({
                            event,
                            runtime,
                            target: activation.href
                              ? { href: activation.href, labelHint: item.label }
                              : null,
                          })
                        }
                      >
                        <ResourceBody body={item.preview.body} match={match} />
                      </a>
                    ) : (
                      <ResourceBody body={item.preview.body} match={match} />
                    )}
                  </div>
                </div>
              )}
              {sourceContent}
              {bodyKind.kind === "named" &&
              match?.excerpt.text &&
              match.excerpt.text !== bodyKind.title ? (
                <ResourceMatchEvidence match={match} />
              ) : null}
              {item.ref.startsWith("highlight:") &&
              (annotation !== null || !historical) ? (
                <div className={styles.annotation}>
                  {annotation ||
                  annotationEdit.value ||
                  annotationFocusRequest !== null ? (
                    <AnnotationNoteHost
                      target={{
                        kind: "highlight",
                        id: item.ref.slice("highlight:".length),
                      }}
                      noteRef={annotation?.note_ref ?? null}
                      completeAnnotation={annotation}
                      showItemsLabel={showSequenceLabels}
                      occurrenceKey={occurrenceKey}
                      label={`edit note: ${annotation?.body_text.split("\n")[0]?.slice(0, 120) || `annotation for ${item.label}`}`}
                      editable={
                        !terminal &&
                        !historical &&
                        (annotationEdit.value ||
                          annotationFocusRequest !== null)
                      }
                      atomicEmbeds={terminal || historical}
                      focusRequest={
                        annotationFocusRequest ?? annotationActivation ?? 0
                      }
                      onActivate={activateAnnotation}
                      onChanged={() => onChanged?.()}
                      onClose={() => {
                        annotationEdit.set(false);
                        setAnnotationActivation(null);
                        onAnnotationClose?.();
                      }}
                    />
                  ) : !terminal && !historical ? (
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={activateAnnotation}
                    >
                      add note
                    </button>
                  ) : null}
                </div>
              ) : null}
              {metadata.parts.length ? (
                <div className={styles.metadata}>
                  <ResourceMetadata parts={metadata.parts} linkSource />
                </div>
              ) : null}
              {unavailable ? (
                <p className={styles.status}>{unavailable}</p>
              ) : null}
              {resourceDetails}
              {connection && !focusedRoot ? (
                <ConnectionDetails
                  connection={connection}
                  showNote={!linkNote.value || !canEditLinkNote}
                />
              ) : null}
              {linkNote.value && connection ? (
                <div hidden={focusedRoot || !canEditLinkNote}>
                  <span className={styles.quiet}>note on link</span>
                  <AnnotationNoteHost
                    target={{ kind: "link", id: connection.edge_id }}
                    noteRef={connection.link_note?.item.ref ?? null}
                    occurrenceKey={occurrenceKey}
                    focusRequest={noteFocusRequest}
                    onChanged={() => onChanged?.()}
                    onClose={() => linkNote.set(false)}
                  />
                </div>
              ) : null}
              {/* Hiding a relation must preserve its editor's pending draft identity. */}
              {details ? <div hidden={focusedRoot}>{details}</div> : null}
              {outline && !terminal && !focusedRoot ? (
                <button
                  type="button"
                  className={cx(styles.textButton, styles.narrowFocus)}
                  disabled={disclosureDisabled}
                  onClick={focusBranch}
                >
                  focus this branch
                </button>
              ) : null}
              {failure && !focusedRoot ? (
                <FeedbackNotice
                  content={failure}
                  announcement="Assertive"
                  actions={[
                    refreshRequired
                      ? {
                          label: "refresh context",
                          onClick: () => {
                            setFailure(null);
                            onChanged?.();
                          },
                        }
                      : { label: "retry", onClick: () => void mutate(true) },
                  ]}
                />
              ) : null}
            </div>
          ),
        }}
        primaryControl={primaryControl}
        actions={
          <div className={styles.actions}>
            {actions ?? (
              <ContextualActionMenu
                label={`Actions for ${item.label}`}
                resourceRef={assumeCanonicalResourceRef(item.action_ref)}
                omitResourceActions={["Open", "OpenInNewPane"]}
                sections={[{ id: "Occurrence", actions: boundCommands }]}
              />
            )}
          </div>
        }
        expanded={
          nestedContent || open ? (
            <div className={styles.children}>
              {nestedContent}
              {open ? (
                <section
                  id={childrenId}
                  aria-label={
                    item.ref.startsWith("highlight:")
                      ? "highlight connections"
                      : "linked resources"
                  }
                >
                  {showSequenceLabels ? (
                    <p className={styles.quiet}>highlight connections</p>
                  ) : null}
                  {placement?.children}
                  {placement ? null : (
                    <ResourceDisclosure
                      resourceRef={item.ref}
                      occurrencePrefix={occurrenceKey}
                      readOnly={historical}
                      historicalBranch={historicalBranch || historical}
                      embeddedInNoteRef={focusedRoot ? null : embeddedInNoteRef}
                      suppressedEdgeIds={
                        annotation ? [annotation.attachment_edge_id] : []
                      }
                    />
                  )}
                </section>
              ) : null}
            </div>
          ) : null
        }
      />
    </ResourceBranch>
  );
}

function connectionReason(
  connection: ConnectionOut,
  historicalBranch: boolean,
): string {
  if (connection.origin === "citation")
    return connection.direction === "incoming" ? "cited by" : "cites";
  return connectionOriginLabel(connection.origin, historicalBranch);
}

export function connectionOriginLabel(
  origin: ConnectionOut["origin"],
  historicalBranch = false,
): string {
  if (historicalBranch && origin === "highlight_note")
    return "current annotation";
  switch (origin) {
    case "user":
      return "linked by you";
    case "citation":
      return "citation";
    case "discovery":
      return "connection discovery";
    case "assistant":
      return "assistant-created link";
    case "system":
      return "added to chat";
    case "highlight_note":
      return "annotation";
    case "link_note":
      return "note on link";
    case "note_body":
      return "embedded resource";
    case "document_embed":
      return "attachment";
  }
}

function ConnectionDetails({
  connection,
  showNote,
}: {
  connection: ConnectionOut;
  showNote: boolean;
}) {
  const machine =
    connection.origin === "discovery" || connection.origin === "assistant";
  const rationale = connection.snapshot?.rationale;
  return (
    <>
      {machine && rationale ? (
        <div className={styles.details}>
          <MachineText
            variant="inline"
            origin={{
              label:
                connection.origin === "discovery"
                  ? "Connection discovery"
                  : "Assistant",
            }}
          >
            {rationale}
          </MachineText>
        </div>
      ) : null}
      {showNote && connection.link_note ? (
        <div className={styles.details}>
          <span className={styles.quiet}>note on link</span>
          <ResourceBody body={connection.link_note.item.preview.body} />
        </div>
      ) : null}
    </>
  );
}

function LiveNoteBody({
  item,
  occurrenceKey,
  authority,
  editable,
  inline,
  structuralKeys,
  publication,
  embeddedItem,
  terminal,
  continuation,
  session,
  indent,
}: {
  item: Item;
  occurrenceKey: string;
  authority: "current" | "local";
  editable: boolean;
  inline: boolean;
  structuralKeys?: StructuralKeys;
  publication?: DailyPublication;
  embeddedItem: Item | null;
  terminal: boolean;
  continuation: OutlineDestination | null;
  session: OutlineSession;
  indent?: () => void;
}) {
  const activated = useResourceDraft(
    `Resources.BodyActivated:${occurrenceKey}`,
    () => authority === "local",
  );
  const text = useText(item.ref);
  const active =
    inline ||
    activated.value ||
    authority === "local" ||
    terminal ||
    session.focus?.key === occurrenceKey;
  const note = usePaneFreeServerValue<Schema<"NoteBlockOut">>({
    key:
      active && authority === "current" && text?.acked == null
        ? `canonical-note:${item.ref}`
        : null,
    stale: "",
    load: (signal) => fetchNote(item.ref.slice("note_block:".length), signal),
  });
  const loaded = note.status === "ready" ? note.data : null;
  useEffect(() => {
    if (session.focus?.key === occurrenceKey && !activated.value)
      activated.set(true);
  }, [activated, session.focus, occurrenceKey]);
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
      {!active ? (
        <button
          type="button"
          className={styles.bodyActivation}
          onClick={() => {
            session.focusRow(occurrenceKey, "end");
            activated.set(true);
          }}
        >
          <ResourceBody body={item.preview.body} />
        </button>
      ) : (!text || typeof text.value === "string") && loaded === null ? (
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
          structuralKeys={structuralKeys ?? (indent ? { indent } : undefined)}
        />
      )}
    </div>
  );
}
