"use client";

import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { filterNodes, flattenVisibleRows } from "@/lib/conversations/forkTree";
import type { BranchGraph, ForkOption } from "@/lib/conversations/types";
import { pluralize } from "@/lib/text/pluralize";
import Button from "@/components/ui/Button";
import ForkGraphOverview from "./ForkGraphOverview";
import ForkTreeView from "./ForkTreeView";
import { useForkPanel } from "./useForkPanel";
import { useForkTreeKeyNav } from "./useForkTreeKeyNav";
import styles from "./ConversationForksPanel.module.css";

export default function ConversationForksPanel({
  conversationId,
  forkOptionsByParentId,
  branchGraph,
  switchableLeafIds,
  activeLeafMessageId,
  selectedPathMessageIds,
  onSelectFork,
  onSelectGraphLeaf,
  onForksChanged,
}: {
  conversationId: string;
  forkOptionsByParentId: Record<string, ForkOption[]>;
  branchGraph: BranchGraph;
  switchableLeafIds?: Set<string>;
  activeLeafMessageId?: string | null;
  selectedPathMessageIds: Set<string>;
  onSelectFork: (fork: ForkOption) => void;
  onSelectGraphLeaf: (leafMessageId: string) => void;
  onForksChanged?: () => void;
}) {
  const panel = useForkPanel({
    conversationId,
    forkOptionsByParentId,
    branchGraph,
    selectedPathMessageIds,
    onForksChanged,
  });
  const [view, setView] = useState<"tree" | "graph">("tree");
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const searchQuery = panel.query.trim().toLowerCase();
  const visibleNodes = searchQuery ? filterNodes(panel.nodes, searchQuery) : panel.nodes;
  const visibleRows = useMemo(
    () => flattenVisibleRows(visibleNodes, panel.expandedIds.ids),
    [panel.expandedIds.ids, visibleNodes],
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

  const { handleTreeKeyDown } = useForkTreeKeyNav({
    visibleRows,
    expandedIds: panel.expandedIds,
    switchableLeafIds,
    editingId: panel.editingId,
    pendingDeleteId: panel.pendingDeleteId,
    setFocusedId,
    onSelectFork,
    onStartRename: panel.startRename,
    onRequestDelete: panel.requestDeleteFork,
    onCancelRename: panel.cancelRename,
    onCancelDelete: panel.cancelDelete,
  });

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
          panel.submitQuery();
        }}
      >
        <Search size={14} aria-hidden="true" />
        <input
          value={panel.query}
          onChange={(event) => panel.setQuery(event.target.value)}
          aria-label="Search forks"
          placeholder="Search forks"
        />
        <Button variant="ghost" size="sm" type="submit" loading={panel.loading}>
          Search
        </Button>
      </form>
      <div className={styles.liveCount} aria-live="polite">
        {pluralize(visibleCount, "fork")} found
      </div>

      {panel.error ? <div className={styles.error}>{panel.error}</div> : null}

      {view === "graph" ? (
        <ForkGraphOverview
          graph={branchGraph}
          searchQuery={panel.query}
          switchableLeafIds={switchableLeafIds}
          onSelectLeaf={onSelectGraphLeaf}
        />
      ) : (
        <ForkTreeView
          nodes={visibleNodes}
          focusedId={focusedId}
          expandedIds={panel.expandedIds.ids}
          switchableLeafIds={switchableLeafIds}
          activeLeafMessageId={activeLeafMessageId}
          selectedPathMessageIds={selectedPathMessageIds}
          searchQuery={searchQuery}
          editingId={panel.editingId}
          editingTitle={panel.editingTitle}
          pendingDeleteId={panel.pendingDeleteId}
          onEditingTitleChange={panel.setEditingTitle}
          onStartRename={panel.startRename}
          onCancelRename={panel.cancelRename}
          onSaveRename={(fork) => {
            void panel.saveRename(fork);
          }}
          onRequestDelete={panel.requestDeleteFork}
          onConfirmDelete={(fork) => {
            void panel.confirmDeleteFork(fork);
          }}
          onCancelDelete={panel.cancelDelete}
          onTreeKeyDown={handleTreeKeyDown}
          onSelectFork={onSelectFork}
        />
      )}
    </div>
  );
}
