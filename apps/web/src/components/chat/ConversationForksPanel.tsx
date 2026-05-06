"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import { Check, ChevronRight, GitBranch, Pencil, Search, Trash2, X } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import { truncateText } from "@/lib/conversations/display";
import type {
  BranchGraph,
  ConversationForksResponse,
  ForkOption,
} from "@/lib/conversations/types";
import Button from "@/components/ui/Button";
import Textarea from "@/components/ui/Textarea";
import ForkGraphOverview from "./ForkGraphOverview";
import styles from "./ConversationForksPanel.module.css";

type ConversationForkNode = ForkOption & { children: ConversationForkNode[] };
type VisibleForkRow = {
  node: ConversationForkNode;
  depth: number;
  parentId: string | null;
};

export default function ConversationForksPanel({
  conversationId,
  forkOptionsByParentId,
  branchGraph,
  switchableLeafIds,
  selectedPathMessageIds,
  onSelectFork,
  onSelectGraphLeaf,
  onForksChanged,
}: {
  conversationId: string;
  forkOptionsByParentId: Record<string, ForkOption[]>;
  branchGraph: BranchGraph;
  switchableLeafIds?: Set<string>;
  selectedPathMessageIds: Set<string>;
  onSelectFork: (fork: ForkOption) => void;
  onSelectGraphLeaf: (leafMessageId: string) => void;
  onForksChanged?: () => void;
}) {
  const fallbackNodes = useMemo(
    () => buildForkTree(Object.values(forkOptionsByParentId).flat()),
    [forkOptionsByParentId],
  );
  const [query, setQuery] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [nodes, setNodes] = useState<ConversationForkNode[]>(fallbackNodes);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"tree" | "graph">("tree");
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

  useEffect(() => {
    setNodes(fallbackNodes);
  }, [fallbackNodes]);

  useEffect(() => {
    setExpandedIds(new Set(collectExpandableIds(nodes)));
  }, [nodes]);

  const loadForks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = submittedQuery
        ? `?${new URLSearchParams({ search: submittedQuery })}`
        : "";
      const response = await apiFetch<ConversationForksResponse>(
        `/api/conversations/${conversationId}/forks${params}`,
      );
      setNodes(buildForkTree(response.data.forks));
    } catch (err) {
      console.error("Failed to load forks:", err);
      setError("Fork search is unavailable.");
      setNodes(fallbackNodes);
    } finally {
      setLoading(false);
    }
  }, [conversationId, fallbackNodes, submittedQuery]);

  useEffect(() => {
    void loadForks();
  }, [loadForks]);

  const saveRename = useCallback(
    async (fork: ConversationForkNode) => {
      const title = editingTitle.trim();
      await apiFetch(`/api/conversations/${conversationId}/forks/${fork.id}`, {
        method: "PATCH",
        body: JSON.stringify({ title: title || null }),
      });
      setNodes((prev) => updateNode(prev, fork.id, { title: title || null }));
      setEditingId(null);
      onForksChanged?.();
    },
    [conversationId, editingTitle, onForksChanged],
  );

  const requestDeleteFork = useCallback(
    (fork: ConversationForkNode) => {
      if (
        fork.active ||
        selectedPathMessageIds.has(fork.leaf_message_id) ||
        selectedPathMessageIds.has(fork.user_message_id) ||
        (fork.assistant_message_id
          ? selectedPathMessageIds.has(fork.assistant_message_id)
          : false)
      ) {
        setError("Switch away from this fork before deleting it.");
        return;
      }
      setError(null);
      setPendingDeleteId(fork.id);
    },
    [selectedPathMessageIds],
  );

  const confirmDeleteFork = useCallback(
    async (fork: ConversationForkNode) => {
      try {
        await apiFetch(`/api/conversations/${conversationId}/forks/${fork.id}`, {
          method: "DELETE",
        });
        setNodes((prev) => removeNode(prev, fork.id));
        setPendingDeleteId(null);
        onForksChanged?.();
      } catch (err) {
        console.error("Failed to delete fork:", err);
        setError("Fork delete failed.");
      }
    },
    [conversationId, onForksChanged],
  );

  const visibleNodes = query.trim()
    ? filterNodes(nodes, query.trim().toLowerCase())
    : nodes;
  const visibleRows = useMemo(
    () => flattenVisibleRows(visibleNodes, expandedIds),
    [expandedIds, visibleNodes],
  );
  const visibleCount = visibleRows.length;

  useEffect(() => {
    if (visibleRows.length === 0) {
      setFocusedId(null);
      return;
    }
    if (!focusedId || !visibleRows.some((row) => row.node.id === focusedId)) {
      setFocusedId(visibleRows[0].node.id);
    }
  }, [focusedId, visibleRows]);

  const focusRow = useCallback((row: VisibleForkRow | undefined) => {
    if (!row) return;
    setFocusedId(row.node.id);
    requestAnimationFrame(() => {
      document.getElementById(treeItemDomId(row.node.id))?.focus();
    });
  }, []);

  const handleTreeKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>, row: VisibleForkRow) => {
      const index = visibleRows.findIndex((item) => item.node.id === row.node.id);
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          event.stopPropagation();
          focusRow(visibleRows[Math.min(visibleRows.length - 1, index + 1)]);
          break;
        case "ArrowUp":
          event.preventDefault();
          event.stopPropagation();
          focusRow(visibleRows[Math.max(0, index - 1)]);
          break;
        case "Home":
          event.preventDefault();
          event.stopPropagation();
          focusRow(visibleRows[0]);
          break;
        case "End":
          event.preventDefault();
          event.stopPropagation();
          focusRow(visibleRows[visibleRows.length - 1]);
          break;
        case "ArrowRight":
          event.preventDefault();
          event.stopPropagation();
          if (row.node.children.length > 0 && !expandedIds.has(row.node.id)) {
            setExpandedIds((prev) => new Set(prev).add(row.node.id));
          } else if (row.node.children.length > 0) {
            focusRow(visibleRows[index + 1]);
          }
          break;
        case "ArrowLeft":
          event.preventDefault();
          event.stopPropagation();
          if (row.node.children.length > 0 && expandedIds.has(row.node.id)) {
            setExpandedIds((prev) => {
              const next = new Set(prev);
              next.delete(row.node.id);
              return next;
            });
          } else if (row.parentId) {
            focusRow(visibleRows.find((item) => item.node.id === row.parentId));
          }
          break;
        case "Enter":
        case " ":
          event.preventDefault();
          event.stopPropagation();
          if (!switchableLeafIds || switchableLeafIds.has(row.node.leaf_message_id)) {
            onSelectFork(toForkOption(row.node));
          }
          break;
        case "F2":
          event.preventDefault();
          event.stopPropagation();
          setEditingId(row.node.id);
          setEditingTitle(row.node.title ?? "");
          break;
        case "Delete":
          event.preventDefault();
          event.stopPropagation();
          requestDeleteFork(row.node);
          break;
        case "Escape":
          if (editingId) {
            event.preventDefault();
            event.stopPropagation();
            setEditingId(null);
          } else if (pendingDeleteId) {
            event.preventDefault();
            event.stopPropagation();
            setPendingDeleteId(null);
          }
          break;
      }
    },
    [
      editingId,
      expandedIds,
      focusRow,
      onSelectFork,
      pendingDeleteId,
      requestDeleteFork,
      switchableLeafIds,
      visibleRows,
    ],
  );

  return (
    <div className={styles.panel}>
      <div className={styles.viewToggle} role="tablist" aria-label="Fork view">
        <button
          type="button"
          role="tab"
          aria-selected={view === "tree"}
          onClick={() => setView("tree")}
        >
          Tree
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "graph"}
          onClick={() => setView("graph")}
        >
          Graph
        </button>
      </div>

      <form
        className={styles.searchRow}
        onSubmit={(event) => {
          event.preventDefault();
          setSubmittedQuery(query.trim());
        }}
      >
        <Search size={14} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search forks"
          placeholder="Search forks"
        />
        <Button variant="ghost" size="sm" type="submit" loading={loading}>
          Search
        </Button>
      </form>
      <div className={styles.liveCount} aria-live="polite">
        {visibleCount} fork{visibleCount === 1 ? "" : "s"} found
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      {view === "graph" ? (
        <ForkGraphOverview
          graph={branchGraph}
          searchQuery={query}
          switchableLeafIds={switchableLeafIds}
          onSelectLeaf={onSelectGraphLeaf}
        />
      ) : visibleNodes.length === 0 ? (
        <p className={styles.empty}>No forks yet.</p>
      ) : (
        <div className={styles.tree} role="tree" aria-label="Conversation forks">
          {visibleNodes.map((node) => (
            <ForkNodeRow
              key={node.id}
              node={node}
              depth={0}
              focusedId={focusedId}
              expandedIds={expandedIds}
              switchableLeafIds={switchableLeafIds}
              selectedPathMessageIds={selectedPathMessageIds}
              searchQuery={query.trim().toLowerCase()}
              editingId={editingId}
              editingTitle={editingTitle}
              pendingDeleteId={pendingDeleteId}
              onEditingTitleChange={setEditingTitle}
              onStartRename={(fork) => {
                setEditingId(fork.id);
                setEditingTitle(fork.title ?? "");
              }}
              onCancelRename={() => setEditingId(null)}
              onSaveRename={(fork) => {
                void saveRename(fork);
              }}
              onRequestDelete={requestDeleteFork}
              onConfirmDelete={(fork) => {
                void confirmDeleteFork(fork);
              }}
              onCancelDelete={() => setPendingDeleteId(null)}
              onTreeKeyDown={handleTreeKeyDown}
              onSelectFork={onSelectFork}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ForkNodeRow({
  node,
  depth,
  parentId = null,
  focusedId,
  expandedIds,
  switchableLeafIds,
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
}: {
  node: ConversationForkNode;
  depth: number;
  parentId?: string | null;
  focusedId: string | null;
  expandedIds: Set<string>;
  switchableLeafIds?: Set<string>;
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
}) {
  const editRef = useRef<HTMLTextAreaElement>(null);
  const activeInPath =
    node.active ||
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
              {node.branch_anchor_preview ? (
                <blockquote className={styles.anchor}>
                  {truncateText(node.branch_anchor_preview, 120)}
                </blockquote>
              ) : null}
              <div className={styles.meta}>
                {activeInPath ? "Active path" : "Inactive"} - {node.status} -{" "}
                {node.message_count} messages
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

function filterNodes(
  nodes: ConversationForkNode[],
  query: string,
): ConversationForkNode[] {
  return nodes.flatMap((node) => {
    const children = filterNodes(node.children ?? [], query);
    if (forkSearchText(node).includes(query) || children.length > 0) {
      return [{ ...node, children }];
    }
    return [];
  });
}

function forkSearchText(node: ConversationForkNode): string {
  return [
    node.title,
    node.preview,
    node.branch_anchor_preview,
    node.status,
    String(node.message_count),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
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

function updateNode(
  nodes: ConversationForkNode[],
  id: string,
  patch: Pick<ConversationForkNode, "title">,
): ConversationForkNode[] {
  return nodes.map((node) =>
    node.id === id
      ? { ...node, ...patch }
      : { ...node, children: updateNode(node.children ?? [], id, patch) },
  );
}

function removeNode(
  nodes: ConversationForkNode[],
  id: string,
): ConversationForkNode[] {
  return nodes
    .filter((node) => node.id !== id)
    .map((node) => ({ ...node, children: removeNode(node.children ?? [], id) }));
}

function buildForkTree(forks: ForkOption[]): ConversationForkNode[] {
  const nodes: ConversationForkNode[] = forks.map((fork) => ({ ...fork, children: [] }));
  const nodeByAssistantId = new Map<string, ConversationForkNode>();
  for (const node of nodes) {
    if (node.assistant_message_id) {
      nodeByAssistantId.set(node.assistant_message_id, node);
    }
  }

  const roots: ConversationForkNode[] = [];
  for (const node of nodes) {
    const parent = nodeByAssistantId.get(node.parent_message_id);
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function flattenVisibleRows(
  nodes: ConversationForkNode[],
  expandedIds: Set<string>,
  depth = 0,
  parentId: string | null = null,
): VisibleForkRow[] {
  const rows: VisibleForkRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth, parentId });
    if (node.children.length > 0 && expandedIds.has(node.id)) {
      rows.push(...flattenVisibleRows(node.children, expandedIds, depth + 1, node.id));
    }
  }
  return rows;
}

function collectExpandableIds(nodes: ConversationForkNode[]): string[] {
  return nodes.flatMap((node) => [
    ...(node.children.length > 0 ? [node.id] : []),
    ...collectExpandableIds(node.children),
  ]);
}

function treeItemDomId(id: string): string {
  return `conversation-fork-${id}`;
}

function toForkOption(node: ConversationForkNode): ForkOption {
  const { children: _children, ...fork } = node;
  return fork;
}
