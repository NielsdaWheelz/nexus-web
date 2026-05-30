"use client";

import { useCallback } from "react";
import type { KeyboardEvent } from "react";
import type { StringIdSet } from "@/lib/useStringIdSet";
import type {
  ConversationForkNode,
  VisibleForkRow,
} from "@/lib/conversations/forkTree";
import type { ForkOption } from "@/lib/conversations/types";
import { treeItemDomId, toForkOption } from "./ForkNodeRow";

export interface UseForkTreeKeyNav {
  handleTreeKeyDown: (event: KeyboardEvent<HTMLElement>, row: VisibleForkRow) => void;
}

export function useForkTreeKeyNav(input: {
  visibleRows: VisibleForkRow[];
  expandedIds: StringIdSet;
  switchableLeafIds?: Set<string>;
  editingId: string | null;
  pendingDeleteId: string | null;
  setFocusedId: (id: string) => void;
  onSelectFork: (fork: ForkOption) => void;
  onStartRename: (fork: ConversationForkNode) => void;
  onRequestDelete: (fork: ConversationForkNode) => void;
  onCancelRename: () => void;
  onCancelDelete: () => void;
}): UseForkTreeKeyNav {
  const {
    visibleRows,
    expandedIds,
    switchableLeafIds,
    editingId,
    pendingDeleteId,
    setFocusedId,
    onSelectFork,
    onStartRename,
    onRequestDelete,
    onCancelRename,
    onCancelDelete,
  } = input;

  const focusRow = useCallback(
    (row: VisibleForkRow | undefined) => {
      if (!row) return;
      setFocusedId(row.node.id);
      requestAnimationFrame(() => {
        document.getElementById(treeItemDomId(row.node.id))?.focus();
      });
    },
    [setFocusedId],
  );

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
          if (row.node.children.length > 0 && !expandedIds.ids.has(row.node.id)) {
            expandedIds.add(row.node.id);
          } else if (row.node.children.length > 0) {
            focusRow(visibleRows[index + 1]);
          }
          break;
        case "ArrowLeft":
          event.preventDefault();
          event.stopPropagation();
          if (row.node.children.length > 0 && expandedIds.ids.has(row.node.id)) {
            expandedIds.remove(row.node.id);
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
          onStartRename(row.node);
          break;
        case "Delete":
          event.preventDefault();
          event.stopPropagation();
          onRequestDelete(row.node);
          break;
        case "Escape":
          if (editingId) {
            event.preventDefault();
            event.stopPropagation();
            onCancelRename();
          } else if (pendingDeleteId) {
            event.preventDefault();
            event.stopPropagation();
            onCancelDelete();
          }
          break;
      }
    },
    [
      editingId,
      expandedIds,
      focusRow,
      onCancelDelete,
      onCancelRename,
      onRequestDelete,
      onSelectFork,
      onStartRename,
      pendingDeleteId,
      switchableLeafIds,
      visibleRows,
    ],
  );

  return { handleTreeKeyDown };
}
