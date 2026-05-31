"use client";

import type { KeyboardEvent } from "react";
import type {
  ConversationForkNode,
  VisibleForkRow,
} from "@/lib/conversations/forkTree";
import type { ForkOption } from "@/lib/conversations/types";
import ForkNodeRow from "./ForkNodeRow";
import styles from "./ConversationForksPanel.module.css";

interface ForkTreeViewProps {
  nodes: ConversationForkNode[];
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

export default function ForkTreeView(props: ForkTreeViewProps) {
  const { nodes, ...rowProps } = props;
  if (nodes.length === 0) {
    return <p className={styles.empty}>No forks yet.</p>;
  }
  return (
    <div className={styles.tree} role="tree" aria-label="Conversation forks">
      {nodes.map((node) => (
        <ForkNodeRow key={node.id} node={node} depth={0} {...rowProps} />
      ))}
    </div>
  );
}
