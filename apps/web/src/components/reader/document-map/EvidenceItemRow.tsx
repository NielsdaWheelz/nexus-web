"use client";

import {
  useId,
  useRef,
  useState,
  type FocusEvent,
} from "react";
import {
  ChevronDown,
  ExternalLink,
  LocateFixed,
  MessageSquare,
} from "lucide-react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import HighlightActionBar from "@/components/highlights/HighlightActionBar";
import type { HighlightActionTarget } from "@/components/highlights/highlightActions";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import ActionMenu from "@/components/ui/ActionMenu";
import MachineText from "@/components/ui/MachineText";
import Pill from "@/components/ui/Pill";
import {
  composeResourceMenu,
  projectResourceActionToMenu,
  resolveResourceCoreActions,
  RESOURCE_ACTION_CATALOG,
  type ResourceActionId,
} from "@/lib/actions/resourceActions";
import {
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { absent } from "@/lib/api/presence";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/api";
import type { HighlightColor } from "@/lib/highlights/segmenter";
import { requestWorkspaceTargetActivation } from "@/lib/workspace/workspaceTargetActivationIngress";
import type { WorkspaceTargetDisposition } from "@/lib/workspace/targetActivation";
import { workspaceTargetClickIntent } from "@/lib/panes/targetLinkActivation";
import {
  executeResourceChat,
  executeResourceOpen,
  executeResourceShare,
} from "@/lib/resources/resourceActionExecution";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import { resourceIconForUri } from "@/lib/resources/resourceKind";
import {
  highlightNoteAssociations,
  isReaderEvidenceUserAssociation,
  isReaderEvidenceUserLink,
} from "@/lib/reader/documentMap";
import type {
  ReaderEvidenceAlsoReference,
  ReaderEvidenceAssociation,
  ReaderEvidenceHighlight,
  ReaderEvidenceItem,
  ReaderEvidenceObject,
  ReaderEvidencePassageGroup,
  ReaderEvidenceSourceTarget,
  ReaderEvidenceUserEdge,
} from "@/lib/reader/documentMap";
import { useShareController } from "@/lib/sharing/controller";
import { anchoredRowForEvidenceItem } from "@/lib/reader/marginItems";
import type { AnchoredReaderRow } from "../useAnchoredReaderProjection";
import styles from "./EvidencePaneSurface.module.css";

export interface EvidenceHighlightActions {
  canQuoteToChat: boolean;
  focusedHighlightId: string | null;
  isEditingBounds: boolean;
  isReflowable: boolean;
  onFocusHighlight: (highlightId: string) => void;
  onQuoteToNewChat: (highlightId: string) => void;
  onQuoteToExistingChat: (highlightId: string) => void;
  onLearn: (highlightId: string) => void;
  onLink: (target: HighlightActionTarget) => void;
  onColorChange: (highlightId: string, color: HighlightColor) => Promise<void>;
  onDelete: (highlightId: string) => Promise<void>;
  onStartEditBounds: () => void;
  onCancelEditBounds: () => void;
  onNoteSave: (
    highlightId: string,
    noteBlockId: string | null,
    createBlockId: string,
    bodyPmJson: Record<string, unknown>,
    clientMutationId: string,
  ) => Promise<HighlightLinkedNoteBlock>;
  onNoteDelete: (
    highlightId: string,
    noteBlockId: string,
    clientMutationId: string,
    shouldApply: () => boolean,
  ) => Promise<void>;
  onOpenNoteLink: (href: string, disposition: WorkspaceTargetDisposition) => void;
}

/**
 * Controls for the stable user-Link facts that survive from Universal Link
 * Authoring, re-expressed on main's Evidence model: a neutral (context) Link
 * carries a Remove control (→ `deleteLink`) and an add/replace/remove note
 * affordance (→ `putLinkNote`/`deleteLinkNote`). The Link's edge id is the
 * mutation key, mirroring the Synapse-dismiss branch on evidence items.
 */
export interface EvidenceLinkActions {
  editingLinkId: string | null;
  onRemoveUserEdge: (edge: ReaderEvidenceUserEdge) => Promise<void>;
  onEditLink: (linkId: string | null) => void;
  onSaveLinkNote: (
    linkId: string,
    noteBlockId: string,
    bodyPmJson: Record<string, unknown>,
  ) => Promise<{ note_block_id: string }>;
  onDeleteLinkNote: (linkId: string) => Promise<void>;
}

type ActivateEvidenceObject = (
  object: ReaderEvidenceObject,
  disposition: WorkspaceTargetDisposition,
) => void;
type ActivateEvidenceSourceTarget = (
  target: ReaderEvidenceSourceTarget,
  disposition: WorkspaceTargetDisposition,
) => void;
type HoverEvidenceItem = (item: ReaderEvidenceItem | null) => void;

export function EvidenceItemRow({
  item,
  group,
  active,
  hovered,
  disclosureOpen,
  editing,
  highlightActions,
  onToggleDisclosure,
  onEditHighlight,
  onActivateObject,
  onActivateSourceTarget,
  onHoverItem,
  onDismissSynapse,
  linkActions,
}: {
  item: ReaderEvidenceItem;
  group: ReaderEvidencePassageGroup | null;
  active: boolean;
  hovered: boolean;
  disclosureOpen: boolean;
  editing: boolean;
  highlightActions: EvidenceHighlightActions;
  onToggleDisclosure: () => void;
  onEditHighlight: (highlightId: string | null) => void;
  onActivateObject: ActivateEvidenceObject;
  onActivateSourceTarget: ActivateEvidenceSourceTarget;
  onHoverItem: HoverEvidenceItem;
  onDismissSynapse: (edgeId: string) => Promise<void>;
  linkActions: EvidenceLinkActions;
}) {
  const removableLink = isReaderEvidenceUserLink(item) ? item : null;
  // Link notes are a capability of neutral top-level Links only. A user stance
  // or a folded association may be removable, but neither mints note parity.
  const annotatableLink =
    removableLink?.role === "context" ? removableLink : null;
  const editingLinkNote =
    annotatableLink !== null &&
    linkActions.editingLinkId === annotatableLink.edge_id;
  const relationshipCount =
    item.associations.length +
    (item.kind === "SourceReference" ? item.targets.length : 0);
  const highlight =
    item.kind === "Highlight" ? evidenceHighlightRow(item, group) : null;
  const linkedNote =
    item.kind === "Highlight" ? linkedHighlightNote(item) : null;
  const relationshipPanelId = useId();
  const handleFocus = (event: FocusEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.target)) onHoverItem(item);
  };
  return (
    <article
      className={styles.item}
      data-evidence-item-id={item.id}
      data-kind={item.kind}
      data-active={active ? "true" : undefined}
      data-hovered={hovered ? "true" : undefined}
      onMouseEnter={() => onHoverItem(item)}
      onMouseLeave={() => onHoverItem(null)}
      onFocusCapture={handleFocus}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          onHoverItem(null);
      }}
    >
      <div className={styles.itemMain}>
        <div className={styles.itemBody}>
          <div className={styles.itemMeta}>
            <span className={styles.kindLabel}>{itemKindLabel(item)}</span>
            {item.kind === "SourceReference" && item.confidence !== "exact" ? (
              <Pill tone="warning">{item.confidence}</Pill>
            ) : null}
          </div>
          <div className={styles.itemLabel}>{item.label}</div>
          {item.kind === "Synapse" ? (
            <MachineText
              variant="inline"
              origin={{ label: "Synapse" }}
              className={styles.itemExcerpt}
            >
              {item.rationale}
            </MachineText>
          ) : item.excerpt.kind === "Present" ? (
            <p className={styles.itemExcerpt}>{item.excerpt.value}</p>
          ) : null}
          {item.kind === "Highlight" && linkedNote && !editing ? (
            <p className={styles.notePreview}>{linkedNote.body_text}</p>
          ) : null}
          {item.kind === "SourceReference" ? (
            <SourceTargetPreview item={item} />
          ) : null}
        </div>
        <div className={styles.itemActions}>
          {highlight ? (
            <HighlightActionBar
              presentation="menu"
              highlight={highlight}
              canQuoteToChat={highlightActions.canQuoteToChat}
              canAddNote
              isReflowable={highlightActions.isReflowable}
              isEditingBounds={
                highlightActions.focusedHighlightId === highlight.id &&
                highlightActions.isEditingBounds
              }
              onSelectColor={(color) =>
                highlightActions.onColorChange(highlight.id, color)
              }
              onAddNote={() => onEditHighlight(highlight.id)}
              onLink={() =>
                highlightActions.onLink({ kind: "existing", highlight })
              }
              onLearn={() => highlightActions.onLearn(highlight.id)}
              onDelete={() => highlightActions.onDelete(highlight.id)}
              onQuoteToNewChat={() =>
                highlightActions.onQuoteToNewChat(highlight.id)
              }
              onQuoteToExistingChat={() =>
                highlightActions.onQuoteToExistingChat(highlight.id)
              }
              onToggleEditBounds={() => {
                if (
                  highlightActions.focusedHighlightId === highlight.id &&
                  highlightActions.isEditingBounds
                ) {
                  highlightActions.onCancelEditBounds();
                } else {
                  highlightActions.onFocusHighlight(highlight.id);
                  highlightActions.onStartEditBounds();
                }
              }}
            />
          ) : null}
          {item.kind === "Link" || item.kind === "Synapse" ? (
            <ObjectOpenButton
              object={item.object}
              onActivate={onActivateObject}
            />
          ) : null}
          {item.kind === "Link" || item.kind === "Synapse" ? (
            <EvidenceResourceActionMenu
              target={item.object.actionTarget}
              label={item.object.label}
              onOpen={(disposition) =>
                onActivateObject(item.object, disposition)
              }
              relationship={
                item.kind === "Synapse"
                  ? {
                      kind: "Dismiss",
                      execute: () => onDismissSynapse(item.edge_id),
                    }
                  : removableLink
                    ? {
                        kind: "Unlink",
                        execute: () =>
                          linkActions.onRemoveUserEdge(removableLink),
                      }
                    : { kind: "None" }
              }
            />
          ) : null}
          {annotatableLink ? (
            <button
              type="button"
              className={styles.iconButton}
              aria-pressed={editingLinkNote}
              aria-label={`Note on link ${annotatableLink.label}`}
              onClick={() =>
                linkActions.onEditLink(
                  editingLinkNote ? null : annotatableLink.edge_id,
                )
              }
            >
              <MessageSquare size={14} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
      {editingLinkNote && annotatableLink ? (
        <div className={styles.noteEditor}>
          <HighlightNoteEditor
            highlightId={annotatableLink.edge_id}
            note={null}
            editable
            onSave={async (linkId, noteBlockId, createBlockId, bodyPmJson) => {
              const saved = await linkActions.onSaveLinkNote(
                linkId,
                noteBlockId ?? createBlockId,
                bodyPmJson,
              );
              return {
                note_block_id: saved.note_block_id,
                body_pm_json: bodyPmJson,
                body_text: "",
              };
            }}
            onDelete={async (linkId) => {
              await linkActions.onDeleteLinkNote(linkId);
            }}
            onOpenLink={highlightActions.onOpenNoteLink}
          />
          <button
            type="button"
            className={styles.doneButton}
            onClick={() => linkActions.onEditLink(null)}
          >
            Done editing note
          </button>
        </div>
      ) : null}
      {editing && item.kind === "Highlight" ? (
        <div className={styles.noteEditor}>
          <HighlightNoteEditor
            highlightId={item.highlight_id}
            note={linkedNote}
            editable
            onSave={highlightActions.onNoteSave}
            onDelete={highlightActions.onNoteDelete}
            onOpenLink={highlightActions.onOpenNoteLink}
          />
          <button
            type="button"
            className={styles.doneButton}
            onClick={() => onEditHighlight(null)}
          >
            Done editing note
          </button>
        </div>
      ) : null}
      {relationshipCount > 0 ? (
        <div className={styles.disclosure}>
          <button
            type="button"
            className={styles.disclosureButton}
            aria-expanded={disclosureOpen}
            aria-controls={relationshipPanelId}
            onClick={onToggleDisclosure}
          >
            <ChevronDown
              size={14}
              aria-hidden="true"
              data-open={disclosureOpen ? "true" : undefined}
            />
            {relationshipCount}{" "}
            {relationshipCount === 1 ? "linked object" : "linked objects"}
          </button>
          {disclosureOpen ? (
            <div id={relationshipPanelId} className={styles.relationshipList}>
              {item.associations.map((association, index) => (
                <AssociationRow
                  key={`${association.relationship}:${association.object.ref}:${index}`}
                  association={association}
                  onActivateObject={onActivateObject}
                  onRemoveUserEdge={linkActions.onRemoveUserEdge}
                />
              ))}
              {item.kind === "SourceReference"
                ? item.targets.map((target) => (
                    <SourceTargetRow
                      key={target.ref}
                      target={target}
                      onActivate={onActivateSourceTarget}
                    />
                  ))
                : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function AssociationDisclosure({
  label,
  associations,
  open,
  onToggle,
  onActivateObject,
  onRemoveUserEdge,
}: {
  label: string;
  associations: Array<ReaderEvidenceAssociation | ReaderEvidenceAlsoReference>;
  open: boolean;
  onToggle: () => void;
  onActivateObject: ActivateEvidenceObject;
  onRemoveUserEdge: EvidenceLinkActions["onRemoveUserEdge"];
}) {
  const panelId = useId();
  return (
    <div className={styles.groupDisclosure}>
      <button
        type="button"
        className={styles.disclosureButton}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <ChevronDown
          size={14}
          aria-hidden="true"
          data-open={open ? "true" : undefined}
        />
        {label} ({associations.length})
      </button>
      {open ? (
        <div id={panelId} className={styles.relationshipList}>
          {associations.map((association, index) => (
            <AssociationRow
              key={`${association.object.ref}:${index}`}
              association={association}
              onActivateObject={onActivateObject}
              onRemoveUserEdge={onRemoveUserEdge}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AssociationRow({
  association,
  onActivateObject,
  onRemoveUserEdge,
}: {
  association: ReaderEvidenceAssociation | ReaderEvidenceAlsoReference;
  onActivateObject: ActivateEvidenceObject;
  onRemoveUserEdge: EvidenceLinkActions["onRemoveUserEdge"];
}) {
  const Icon = resourceIconForUri(association.object.ref);
  const removableAssociation = isReaderEvidenceUserAssociation(association)
    ? association
    : null;
  const objectActionLabel =
    association.object.kind === "Media"
      ? `Open target in reader for ${association.object.label}`
      : `Open ${association.object.label}`;
  return (
    <div className={styles.relationshipRow}>
      <span className={styles.relationshipKind}>
        {relationshipLabel(association.relationship)}
      </span>
      <div className={styles.relationshipObject}>
        <button
          type="button"
          className={styles.objectButton}
          disabled={association.object.activation.kind === "none"}
          aria-label={objectActionLabel}
          onClick={(event) =>
            onActivateObject(
              association.object,
              workspaceTargetClickIntent(event).disposition,
            )
          }
        >
          <Icon size={14} aria-hidden="true" />
          <span>{association.object.label}</span>
          <ExternalLink size={12} aria-hidden="true" />
        </button>
        <EvidenceResourceActionMenu
          target={association.object.actionTarget}
          label={association.object.label}
          onOpen={(disposition) =>
            onActivateObject(association.object, disposition)
          }
          relationship={
            removableAssociation
              ? {
                  kind: "Unlink",
                  execute: () => onRemoveUserEdge(removableAssociation),
                }
              : { kind: "None" }
          }
        />
      </div>
      {association.object.excerpt.kind === "Present" ? (
        <p className={styles.relationshipExcerpt}>
          {association.object.excerpt.value}
        </p>
      ) : null}
    </div>
  );
}

type EvidenceRelationshipAction =
  | { kind: "None" }
  | { kind: "Unlink"; execute: () => Promise<void> }
  | { kind: "Dismiss"; execute: () => Promise<void> };

function EvidenceResourceActionMenu({
  target,
  label,
  onOpen,
  relationship,
}: {
  target: ResourceActionSubject;
  label: string;
  onOpen: (disposition: WorkspaceTargetDisposition) => void;
  relationship: EvidenceRelationshipAction;
}) {
  const { openShare } = useShareController();
  const busyRef = useRef<Set<ResourceActionId>>(new Set());
  const [busyIds, setBusyIds] = useState<ReadonlySet<ResourceActionId>>(
    () => new Set(),
  );
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);

  async function runAction({
    id,
    execute,
    failure,
  }: {
    id: ResourceActionId;
    execute: () => Promise<void>;
    failure: string;
  }) {
    if (busyRef.current.has(id)) return;
    busyRef.current.add(id);
    setBusyIds(new Set(busyRef.current));
    setFeedback(null);
    try {
      await execute();
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
      setFeedback(toFeedback(error, { fallback: failure }));
    } finally {
      busyRef.current.delete(id);
      setBusyIds(new Set(busyRef.current));
    }
  }

  const core = resolveResourceCoreActions({
    target,
    projection: "Representation",
    busyIds,
    executors: {
      open: (subject: ResourceActionSubject) =>
        executeResourceOpen({
          target: subject,
          resourceNavigation: {
            labelHint: label,
            activateTarget: ({ disposition }) =>
              onOpen(disposition),
            disposition: { kind: "Follow" },
          },
        }),
      share: (subject, { triggerEl }) =>
        executeResourceShare({
          subject,
          openShare,
          options: {
            returnFocusTo: () => triggerEl,
            returnFocusFallback: absent(),
          },
        }),
      chat: (subject: ResourceActionSubject) =>
        runAction({
          id: RESOURCE_ACTION_CATALOG.Chat.id,
          execute: () =>
            executeResourceChat({
              ref: subject.ref,
              openConversation: (conversationId) => {
                requestWorkspaceTargetActivation({
                  target: {
                    href: `/conversations/${conversationId}`,
                    labelHint: "Chat",
                  },
                  disposition: { kind: "Adopt" },
                  modality: "Programmatic",
                });
              },
            }),
          failure: "Chat could not be started.",
        }),
    },
  });
  const relationshipDescriptor =
    relationship.kind === "None"
      ? null
      : projectResourceActionToMenu({
          kind: "command",
          catalogKey:
            relationship.kind === "Unlink"
              ? "UnlinkConnection"
              : "DismissConnection",
          busy: busyIds.has(
            relationship.kind === "Unlink"
              ? RESOURCE_ACTION_CATALOG.UnlinkConnection.id
              : RESOURCE_ACTION_CATALOG.DismissConnection.id,
          ),
          onSelect: () => {
            void runAction({
              id:
                relationship.kind === "Unlink"
                  ? RESOURCE_ACTION_CATALOG.UnlinkConnection.id
                  : RESOURCE_ACTION_CATALOG.DismissConnection.id,
              execute: relationship.execute,
              failure:
                relationship.kind === "Unlink"
                  ? "Connection could not be unlinked."
                  : "Connection could not be dismissed.",
            });
          },
        });
  const options = composeResourceMenu({
    ...core,
    relationships: relationshipDescriptor ? [relationshipDescriptor] : [],
  });
  if (options.length === 0) return null;
  return (
    <>
      <ActionMenu options={options} label={`Actions for ${label}`} />
      {feedback ? <FeedbackNotice feedback={feedback} /> : null}
    </>
  );
}

function ObjectOpenButton({
  object,
  onActivate,
}: {
  object: ReaderEvidenceObject;
  onActivate: ActivateEvidenceObject;
}) {
  return (
    <button
      type="button"
      className={styles.iconButton}
      disabled={object.activation.kind === "none"}
      aria-label={`Open ${object.label}`}
      onClick={(event) =>
        onActivate(object, workspaceTargetClickIntent(event).disposition)
      }
    >
      <ExternalLink size={14} aria-hidden="true" />
    </button>
  );
}

function SourceTargetPreview({
  item,
}: {
  item: Extract<ReaderEvidenceItem, { kind: "SourceReference" }>;
}) {
  const body = item.targets.find(
    (target) => target.body.kind === "Present",
  )?.body;
  return body?.kind === "Present" ? (
    <p className={styles.sourceBody}>{body.value}</p>
  ) : null;
}

function SourceTargetRow({
  target,
  onActivate,
}: {
  target: ReaderEvidenceSourceTarget;
  onActivate: ActivateEvidenceSourceTarget;
}) {
  const label =
    target.label.kind === "Present"
      ? target.label.value
      : kindLabel(target.apparatus_kind);
  return (
    <div className={styles.relationshipRow}>
      <span className={styles.relationshipKind}>Source target</span>
      <button
        type="button"
        className={styles.objectButton}
        disabled={target.activation.kind === "none"}
        onClick={(event) =>
          onActivate(target, workspaceTargetClickIntent(event).disposition)
        }
      >
        <span>{label}</span>
        {target.resolution.kind === "Resolved" ? (
          <LocateFixed size={12} aria-hidden="true" />
        ) : (
          <ExternalLink size={12} aria-hidden="true" />
        )}
      </button>
      <EvidenceResourceActionMenu
        target={target.actionTarget}
        label={label}
        onOpen={(disposition) => onActivate(target, disposition)}
        relationship={{ kind: "None" }}
      />
      {target.body.kind === "Present" ? (
        <p className={styles.relationshipExcerpt}>{target.body.value}</p>
      ) : null}
    </div>
  );
}

function evidenceHighlightRow(
  item: ReaderEvidenceHighlight,
  group: ReaderEvidencePassageGroup | null,
): AnchoredReaderRow {
  const anchored = group ? anchoredRowForEvidenceItem(group, item) : null;
  const notes = highlightNoteAssociations(item).map((association) => ({
    note_block_id: association.object.note_block_id,
    body_pm_json: association.object.body_pm_json,
    body_text:
      association.object.excerpt.kind === "Present"
        ? association.object.excerpt.value
        : "",
  }));
  const conversations = item.associations
    .filter(
      (
        association,
      ): association is ReaderEvidenceAssociation & {
        object: Extract<ReaderEvidenceObject, { kind: "Chat" }>;
      } => association.object.kind === "Chat",
    )
    .map((association) => ({
      conversation_id: association.object.conversation_id,
      title: association.object.label,
    }));
  return {
    id: item.highlight_id,
    exact: item.quote,
    color: item.color,
    anchor: anchored?.anchor,
    page_number: anchored?.page_number,
    quads: anchored?.quads,
    stable_order_key: anchored?.stable_order_key,
    prefix: item.prefix,
    suffix: item.suffix,
    created_at: item.created_at,
    updated_at: item.updated_at,
    is_owner: item.is_owner,
    linked_note_blocks: notes,
    linked_conversations: conversations,
  };
}

function linkedHighlightNote(
  item: ReaderEvidenceHighlight,
): HighlightLinkedNoteBlock | null {
  const note = highlightNoteAssociations(item)[0]?.object;
  if (!note) return null;
  return {
    note_block_id: note.note_block_id,
    body_pm_json: note.body_pm_json,
    body_text: note.excerpt.kind === "Present" ? note.excerpt.value : "",
  };
}

function itemKindLabel(item: ReaderEvidenceItem): string {
  switch (item.kind) {
    case "Highlight":
      return "Highlight";
    case "SourceReference":
      return "Source reference";
    case "GeneratedCitation":
      return "Cited by";
    case "Link":
      return "Link";
    case "Synapse":
      return "Synapse";
  }
}

function relationshipLabel(
  relationship:
    | ReaderEvidenceAssociation["relationship"]
    | ReaderEvidenceAlsoReference["relationship"],
): string {
  switch (relationship) {
    case "AuthoredIn":
      return "Cited in";
    case "DirectlyAttached":
      return "Attached directly";
    case "AlsoReferences":
      return "Also references this passage";
  }
}

function kindLabel(kind: ReaderEvidenceSourceTarget["apparatus_kind"]): string {
  switch (kind) {
    case "footnote_ref":
    case "footnote":
      return "Footnote";
    case "endnote_ref":
    case "endnote":
      return "Endnote";
    case "bibliography_ref":
    case "bibliography_entry":
      return "Reference";
    case "sidenote_ref":
    case "sidenote":
      return "Sidenote";
    case "margin_note_ref":
    case "margin_note":
      return "Margin note";
    case "reference_section":
      return "References";
  }
}
