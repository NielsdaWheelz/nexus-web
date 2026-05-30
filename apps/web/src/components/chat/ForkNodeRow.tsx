"use client";

import { useEffect, useRef } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { Check, ChevronRight, GitBranch, Pencil, Trash2, X } from "lucide-react";
import { truncateText } from "@/lib/conversations/display";
import { forkSearchText } from "@/lib/conversations/forkTree";
import type {
  ConversationForkNode,
  VisibleForkRow,
} from "@/lib/conversations/forkTree";
import type { ForkOption } from "@/lib/conversations/types";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import styles from "./ConversationForksPanel.module.css";

export function treeItemDomId(id: string): string {
  return `conversation-fork-${id}`;
}

export function toForkOption(node: ConversationForkNode): ForkOption {
  const { children: _children, ...fork } = node;
  return fork;
}

export interface ForkNodeRowProps {
  node: ConversationForkNode;
  depth: number;
  parentId?: string | null;
  focusedId: string | null;
  expandedIds: Set<string>;
  switchableLeafIds?: Set<string>;
  activeLeafMessageId?: string | null;
  selectedPathMessageIds: Set<string>;
  searchQuery: string;
  editingId: string | null;
  editingTitle: string;
  pendingDeleteId: string | null;
  onEditingTitleChange: (title: string) => void;
  onStartRename: (fork: ConversationForkNode) => void;
  onCancelRename: () => void;
  onSaveRename: (fork: ConversationForkNode) => void;
  onRequestDelete: (fork: ConversationForkNode) => void;
  onConfirmDelete: (fork: ConversationForkNode) => void;
  onCancelDelete: () => void;
  onTreeKeyDown: (event: KeyboardEvent<HTMLElement>, row: VisibleForkRow) => void;
  onSelectFork: (fork: ForkOption) => void;
}

export default function ForkNodeRow({
  node,
  depth,
  parentId = null,
  focusedId,
  expandedIds,
  switchableLeafIds,
  activeLeafMessageId,
  selectedPathMessageIds,
  searchQuery,
  editingId,
  editingTitle,
  pendingDeleteId,
  onEditingTitleChange,
  onStartRename,
  onCancelRename,
  onSaveRename,
  onRequestDelete,
  onConfirmDelete,
  onCancelDelete,
  onTreeKeyDown,
  onSelectFork,
}: ForkNodeRowProps) {
  const editRef = useRef<HTMLTextAreaElement>(null);
  const activeInPath =
    node.active ||
    node.leaf_message_id === activeLeafMessageId ||
    selectedPathMessageIds.has(node.leaf_message_id) ||
    selectedPathMessageIds.has(node.user_message_id) ||
    (node.assistant_message_id ? selectedPathMessageIds.has(node.assistant_message_id) : false);
  const title = node.title || truncateText(node.preview, 90);
  const expanded = expandedIds.has(node.id);
  const hasChildren = node.children.length > 0;
  const switchable = !switchableLeafIds || switchableLeafIds.has(node.leaf_message_id);
  const matchesSearch = searchQuery ? forkSearchText(node).includes(searchQuery) : false;
  const deleteDescriptionId = `${treeItemDomId(node.id)}-delete-description`;

  useEffect(() => {
    if (editingId === node.id) {
      editRef.current?.focus();
    }
  }, [editingId, node.id]);

  return (
    <article
      id={treeItemDomId(node.id)}
      className={styles.node}
      data-active={activeInPath ? "true" : "false"}
      data-match={matchesSearch ? "true" : "false"}
      role="treeitem"
      tabIndex={focusedId === node.id ? 0 : -1}
      aria-level={depth + 1}
      aria-selected={activeInPath}
      aria-expanded={hasChildren ? expanded : undefined}
      style={{ "--depth": depth } as CSSProperties}
      onKeyDown={(event) => onTreeKeyDown(event, { node, depth, parentId })}
    >
      {hasChildren ? (
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={styles.chevron}
          data-expanded={expanded ? "true" : "false"}
        />
      ) : (
        <GitBranch size={14} aria-hidden="true" />
      )}
      <div className={styles.nodeBody}>
        {editingId === node.id ? (
          <Textarea
            ref={editRef}
            value={editingTitle}
            onChange={(event) => onEditingTitleChange(event.target.value)}
            aria-label={`Rename fork ${title}`}
            minRows={1}
            maxRows={3}
          />
        ) : (
          <>
            {switchable ? (
              <button
                type="button"
                className={styles.titleButton}
                onClick={() => {
                  onSelectFork(toForkOption(node));
                }}
                aria-label={`Switch to fork ${title}`}
              >
                {title}
              </button>
            ) : (
              <span className={styles.titleText}>{title}</span>
            )}
            {activeInPath ? <span className={styles.pathBadge}>Active path</span> : null}
            {node.branch_anchor_preview ? (
              <blockquote className={styles.anchor}>
                {truncateText(node.branch_anchor_preview, 120)}
              </blockquote>
            ) : null}
            <div className={styles.meta}>
              {node.status} - {node.message_count} messages
            </div>
          </>
        )}
      </div>
      <div className={styles.actions}>
        {editingId === node.id ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => onSaveRename(node)}
              aria-label={`Save fork ${title}`}
            >
              <Check size={14} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={onCancelRename}
              aria-label={`Cancel rename fork ${title}`}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              onClick={() => onStartRename(node)}
              aria-label={`Rename fork ${title}`}
            >
              <Pencil size={14} aria-hidden="true" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              disabled={activeInPath}
              onClick={() => onRequestDelete(node)}
              aria-label={`Delete fork ${title}`}
            >
              <Trash2 size={14} aria-hidden="true" />
            </Button>
          </>
        )}
      </div>
      {pendingDeleteId === node.id ? (
        <div
          className={styles.deleteConfirm}
          role="group"
          aria-label={deleteConfirmationLabel(node)}
          aria-describedby={deleteDescriptionId}
        >
          <div aria-hidden="true">
            Delete this fork and {messageCountLabel(node.message_count)}?
          </div>
          <span id={deleteDescriptionId} className="sr-only">
            {deleteConfirmationDescription(node)}
          </span>
          <Button variant="danger" size="sm" onClick={() => onConfirmDelete(node)}>
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={onCancelDelete}>
            Cancel
          </Button>
        </div>
      ) : null}
      {hasChildren && expanded ? (
        <div className={styles.childGroup} role="group">
          {node.children.map((child) => (
            <ForkNodeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              parentId={node.id}
              focusedId={focusedId}
              expandedIds={expandedIds}
              switchableLeafIds={switchableLeafIds}
              activeLeafMessageId={activeLeafMessageId}
              selectedPathMessageIds={selectedPathMessageIds}
              searchQuery={searchQuery}
              editingId={editingId}
              editingTitle={editingTitle}
              pendingDeleteId={pendingDeleteId}
              onEditingTitleChange={onEditingTitleChange}
              onStartRename={onStartRename}
              onCancelRename={onCancelRename}
              onSaveRename={onSaveRename}
              onRequestDelete={onRequestDelete}
              onConfirmDelete={onConfirmDelete}
              onCancelDelete={onCancelDelete}
              onTreeKeyDown={onTreeKeyDown}
              onSelectFork={onSelectFork}
            />
          ))}
        </div>
      ) : null}
    </article>
  );
}

function messageCountLabel(count: number): string {
  return `${count} message${count === 1 ? "" : "s"}`;
}

function deleteConfirmationLabel(node: ConversationForkNode): string {
  return `Confirm delete fork. ${deleteConfirmationDescription(node)}`;
}

function deleteConfirmationDescription(node: ConversationForkNode): string {
  return [
    `Title: ${node.title?.trim() || "Untitled fork"}`,
    `Reply: ${node.preview}`,
    node.branch_anchor_preview ? `Quote: ${node.branch_anchor_preview}` : null,
    `Subtree: ${messageCountLabel(node.message_count)}`,
  ]
    .filter(Boolean)
    .join(". ");
}
