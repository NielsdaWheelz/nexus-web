"use client";

import { useId, type FocusEvent } from "react";
import {
  ChevronDown,
  ExternalLink,
  LocateFixed,
  MessageSquare,
  X,
} from "lucide-react";
import HighlightActionBar from "@/components/highlights/HighlightActionBar";
import type { HighlightActionTarget } from "@/components/highlights/highlightActions";
import HighlightNoteEditor from "@/components/notes/HighlightNoteEditor";
import MachineText from "@/components/ui/MachineText";
import Pill from "@/components/ui/Pill";
import type { HighlightLinkedNoteBlock } from "@/lib/highlights/api";
import type { HighlightColor } from "@/lib/highlights/segmenter";
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
import { anchoredRowForEvidenceItem } from "@/lib/reader/marginItems";
import type { AnchoredReaderRow } from "../useAnchoredReaderProjection";
import styles from "./EvidencePaneSurface.module.css";

export interface EvidenceHighlightActions {
  canQuoteToChat: boolean;
  focusedHighlightId: string | null;
  isEditingBounds: boolean;
  isReflowable: boolean;
  onFocusHighlight: (highlightId: string) => void;
  onQuoteToChat: (highlightId: string) => void;
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
  onOpenNoteLink: (href: string, options: { newPane: boolean }) => void;
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
  onRemoveUserEdge: (edge: ReaderEvidenceUserEdge) => void;
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
  options: { newPane: boolean },
) => void;
type ActivateEvidenceSourceTarget = (
  target: ReaderEvidenceSourceTarget,
  options: { newPane: boolean },
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
  onDismissSynapse: (edgeId: string) => void;
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
              variant="existing"
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
              onDelete={() => highlightActions.onDelete(highlight.id)}
              onQuoteToNewChat={() =>
                highlightActions.onQuoteToChat(highlight.id)
              }
              onQuoteToExistingChat={() =>
                highlightActions.onQuoteToChat(highlight.id)
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
          {item.kind === "Synapse" ? (
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`Dismiss Synapse ${item.label}`}
              onClick={() => onDismissSynapse(item.edge_id)}
            >
              <X size={14} aria-hidden="true" />
            </button>
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
          {removableLink ? (
            <button
              type="button"
              className={styles.iconButton}
              aria-label={`Remove link ${removableLink.label}`}
              onClick={() => linkActions.onRemoveUserEdge(removableLink)}
            >
              <X size={14} aria-hidden="true" />
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
            onActivateObject(association.object, { newPane: event.shiftKey })
          }
        >
          <Icon size={14} aria-hidden="true" />
          <span>{association.object.label}</span>
          <ExternalLink size={12} aria-hidden="true" />
        </button>
        {removableAssociation ? (
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Remove connection to ${association.object.label}`}
            onClick={() => onRemoveUserEdge(removableAssociation)}
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
      {association.object.excerpt.kind === "Present" ? (
        <p className={styles.relationshipExcerpt}>
          {association.object.excerpt.value}
        </p>
      ) : null}
    </div>
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
      onClick={(event) => onActivate(object, { newPane: event.shiftKey })}
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
        onClick={(event) => onActivate(target, { newPane: event.shiftKey })}
      >
        <span>{label}</span>
        {target.resolution.kind === "Resolved" ? (
          <LocateFixed size={12} aria-hidden="true" />
        ) : (
          <ExternalLink size={12} aria-hidden="true" />
        )}
      </button>
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
