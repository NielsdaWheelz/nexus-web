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
  FeedbackStatus,
  useFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import MediaActions from "@/components/media/MediaActions";
import MediaIdentity from "@/components/media/MediaIdentity";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { findPaneLandmarkFocusTarget } from "@/lib/workspace/paneDom";
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
import { assertNever } from "@/lib/assertNever";
import type { Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import {
  connectionMutationErrorMessage,
  endpointForResource,
  mutateConnection,
  type ConnectionCommand,
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
export type Incoming =
  | {
      kind: "edge";
      edge_id: string;
      origin: ConnectionOut["origin"];
      mutation: ConnectionMutation | null;
      creation: ConnectionOut["creation"];
    }
  | { kind: "context"; mutation: Schema<"ContextItemOut">["mutation"] }
  | null;

/** shared navigation and controls; supplied bodies retain their owner's interaction.
 * selection is an explicit outline capability. occurrence cues omit redundant identity;
 * focus keeps resource extras visible and hides incoming-relation extras.
 * internal placement drops belong to the nearest actual row before nested editors;
 * external text and files remain editor-owned.
 * incoming identity selects relationship actions; roots retain resource actions. */
export default function ResourceOutlineRow({
  item: suppliedItem,
  occurrenceKey,
  presentation,
  incoming,
  connection,
  edgeId,
  representedEdgeIds = [],
  embeddedInNoteRef = null,
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
  resourceDetails,
  nestedContent,
  details,
  primaryControl,
  userUnlinkAction,
  commandDisabledReason: suppliedDisabledReason,
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
  incoming: Incoming;
  connection?: ConnectionOut;
  edgeId?: string;
  representedEdgeIds?: readonly string[];
  embeddedInNoteRef?: string | null;
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
  userUnlinkAction?: Extract<ActionDescriptor, { kind: "command" }> | null;
  commandDisabledReason?: string;
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
  const seed = !historical && suppliedItem.preview.body.kind === "media"
    ? suppliedItem.preview.body.media_summary : null;
  const summaries = useMediaSummaries(seed === null ? [] : [seed]);
  const summary = seed === null ? null : summaries.resolve(seed);
  const item: Item = seed === null ? suppliedItem : summary === null ? {
    ...suppliedItem,
    label: "unavailable",
    missing: true,
    activation: {
      kind: "none",
      href: null,
      resource_ref: suppliedItem.ref,
      unavailable_reason: "source_unavailable",
    },
    preview: {
      body: { kind: "named", title: "unavailable", media_kind: null, contributors: null },
      source: null,
      annotation: null,
    },
  } : {
    ...suppliedItem,
    label: summary.title,
    preview: { ...suppliedItem.preview, body: { kind: "media", media_summary: summary } },
  };
  const feedback = useFeedback();
  const session = useContext(OutlineSessionContext);
  const commandDisabledReason =
    suppliedDisabledReason ??
    (session?.activeReference != null
      ? "finish linking or return to prose first"
      : undefined);
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
  const effectiveIncoming = focusedRoot ? null : incoming;
  const enteringEdgeId =
    edgeId ?? (incoming?.kind === "edge" ? incoming.edge_id : null);
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
  const submitted = useRef<ConnectionCommand | null>(null);
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
  const mutation = effectiveIncoming?.mutation ?? null;
  const userLink =
    effectiveIncoming?.kind === "edge" && effectiveIncoming.origin === "user";
  const sourceResource =
    effectiveIncoming === null && item.action_ref !== item.ref;
  let removalLabel = "remove connection";
  if (mutation?.kind === "detach_context")
    removalLabel = "remove from future context";
  else if (userLink) removalLabel = "remove link from both items; keep their notes";
  if (busy) removalLabel = userLink ? "removing link…" : "removing connection…";
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
  const metadataParts = summary === null ? metadata.parts : metadata.parts.filter((part) => !["identity", "contributors", "publication", "consumption", "duration"].includes(part.key));
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
    if (!effectiveIncoming || !mutation || busyRef.current || commandDisabledReason)
      return;
    let command = submitted.current;
    if (!retry) {
      switch (mutation.kind) {
        case "unlink":
          if (effectiveIncoming.kind !== "edge")
            throw new Error("unlink requires an exact edge");
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
          position: continuation.position,
          label: item.label,
          onSelected: (target, targetItem, authored) => {
            void session.insertReference({ destination: continuation, target, targetItem, authored });
          },
          onActiveChange: (active) =>
            session.setReferenceActive(occurrenceKey, active),
        }}
        editable={
          session.activeReference === null ||
          session.activeReference === occurrenceKey
        }
        onInsert={async (next, consumed_reference) =>
          (await session.insertNote({
            destination: continuation,
            body: next,
            consumed_reference,
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
  const commands: ActionDescriptor[] = effectiveIncoming === null
    ? [...resourceActions] : [...occurrenceActions];
  if (effectiveIncoming === null && !placement && defaultSource && !terminal)
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
      label: effectiveIncoming === null ? "open" : "open linked item",
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
  const made = effectiveIncoming?.kind === "edge" ? effectiveIncoming.creation : null;
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
  if (effectiveIncoming === null && annotation?.activation.href)
    commands.push({
      kind: "link",
      id: "Resource.OpenAnnotation",
      label: "edit annotation",
      href: annotation.activation.href,
    });
  const removalUnavailable = effectiveIncoming !== null &&
    (mutation === null || (effectiveIncoming.kind === "edge" &&
      effectiveIncoming.origin === "user" && userUnlinkAction === null));
  if (effectiveIncoming?.kind === "edge" && effectiveIncoming.origin === "discovery")
    commands.push({
      kind: "custom",
      id: "Resource.Relation.Rediscovery",
      label: "future scans may suggest this connection again",
      render: () => <FeedbackStatus
        content={{ tone: "Neutral", title: "future scans may suggest this connection again" }}
        announcement="Polite"
      />,
    });
  if (removalUnavailable)
    commands.push({
      kind: "custom",
      id: "Resource.Relation.Unavailable",
      label: "this connection can’t be removed here",
      render: () => <FeedbackStatus
        content={{ tone: "Neutral", title: "this connection can’t be removed here" }}
        announcement="None"
      />,
    });
  else if (mutation) {
    if (effectiveIncoming?.kind === "edge" && effectiveIncoming.origin === "user" && userUnlinkAction)
      commands.push(userUnlinkAction);
    else
      commands.push({
        kind: "command",
        id: `Resource.Relation.${mutation.kind}`,
        label: removalLabel,
        disabled: busy,
        disabledReason: busy ? "removal is pending" : undefined,
        restoreFocusOnClose: false,
        onSelect: () => void mutate(),
      });
  }
  if (
    effectiveIncoming === null &&
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
    action.kind === "link" && !action.onActivate
      ? { ...action, onActivate: (event: TargetActivationEvent) =>
          activateTargetLink({ event, runtime, target: { href: action.href } }) }
      : action,
  );
  if (defect) throw defect.error;
  if (projection.kind === "omit") return null;
  return (
    <ResourceBranch value={childrenBranch}>
      <ResourceRow
        primary={{ kind: "static" }}
        title={null}
        media={summary !== null}
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
          "data-media-identity": summary !== null || undefined,
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
              {summary !== null ? <MediaIdentity subject={{kind:"Stored",summary}} /> : null}
              {seed !== null ? <MediaSummaryNotice error={summaries.error} retry={summaries.retry} busy={summaries.retrying} /> : null}
              {sourceContent}
              {(bodyKind.kind === "named" || bodyKind.kind === "media") &&
              match?.excerpt.text &&
              match.excerpt.text !== (bodyKind.kind === "media" ? bodyKind.media_summary.title : bodyKind.title) ? (
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
              {metadataParts.length ? (
                <div className={styles.metadata}>
                  <ResourceMetadata parts={metadataParts} linkSource />
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
                    target={{ kind: "link", id: connection.edge_id, sourceRef: connection.source.ref }}
                    linkNote={connection.link_note}
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
        primaryControl={focusedRoot ? undefined : primaryControl}
        actions={
          <div className={styles.actions}>
            {summary !== null ? (
              <MediaActions
                subject={{ kind: "Stored", summary }}
                knownDescriptor={null}
                density="Row"
                returnFocus={() => element.current?.querySelector<HTMLElement>("[data-row-focusable]")
                  ?? findPaneLandmarkFocusTarget(runtime?.paneId)}
              />
            ) : null}
            <ContextualActionMenu
              title={item.label}
              subjectKey={occurrenceKey}
              label={`more actions for ${item.label}`}
              {...(effectiveIncoming === null ? { resourceRef: assumeCanonicalResourceRef(item.action_ref) } : {})}
              showSourceSubject={sourceResource}
              commandDisabledReason={commandDisabledReason}
              omitResourceActions={["Open", "OpenInNewPane"]}
              sections={[{ id: "Occurrence", actions: boundCommands }]}
            />
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
      return "linked automatically by the librarian";
    case "assistant":
      return "linked by the librarian";
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
            origin={{ label: "librarian" }}
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
        ? `/notes/blocks/${encodeURIComponent(item.ref.slice("note_block:".length))}`
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
