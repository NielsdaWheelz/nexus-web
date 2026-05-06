"use client";

import { GitBranch } from "lucide-react";
import { truncateText } from "@/lib/conversations/display";
import type { BranchGraph, BranchGraphNode } from "@/lib/conversations/types";
import styles from "./ForkGraphOverview.module.css";

const COLUMN_WIDTH = 180;
const ROW_HEIGHT = 96;
const NODE_WIDTH = 148;
const NODE_HEIGHT = 62;

export default function ForkGraphOverview({
  graph,
  searchQuery,
  switchableLeafIds,
  onSelectLeaf,
}: {
  graph: BranchGraph;
  searchQuery: string;
  switchableLeafIds?: Set<string>;
  onSelectLeaf: (leafMessageId: string) => void;
}) {
  const nodes = [...graph.nodes].sort((a, b) => a.row - b.row || a.depth - b.depth);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const maxDepth = nodes.reduce((max, node) => Math.max(max, node.depth), 0);
  const maxRow = nodes.reduce((max, node) => Math.max(max, node.row), 0);
  const width = (maxDepth + 1) * COLUMN_WIDTH;
  const height = (maxRow + 1) * ROW_HEIGHT;
  const query = searchQuery.trim().toLowerCase();

  if (nodes.length === 0) {
    return <p className={styles.empty}>No branch graph yet.</p>;
  }

  return (
    <div className={styles.scroller} aria-label="Conversation branch graph">
      <div className={styles.graph} style={{ width, height }}>
        <svg className={styles.edges} width={width} height={height} aria-hidden="true">
          {graph.edges.map((edge) => {
            const from = nodeById.get(edge.from);
            const to = nodeById.get(edge.to);
            if (!from || !to) return null;
            const x1 = from.depth * COLUMN_WIDTH + NODE_WIDTH;
            const y1 = from.row * ROW_HEIGHT + NODE_HEIGHT / 2;
            const x2 = to.depth * COLUMN_WIDTH;
            const y2 = to.row * ROW_HEIGHT + NODE_HEIGHT / 2;
            const mid = x1 + (x2 - x1) / 2;
            return (
              <path
                key={`${edge.from}:${edge.to}`}
                d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                className={styles.edge}
              />
            );
          })}
        </svg>

        {nodes.map((node) => {
          const switchable =
            node.leaf &&
            (!switchableLeafIds || switchableLeafIds.has(node.leaf_message_id));
          const label = graphNodeLabel(node);
          const matched = query ? graphNodeSearchText(node).includes(query) : false;
          const style = {
            left: node.depth * COLUMN_WIDTH,
            top: node.row * ROW_HEIGHT,
            width: NODE_WIDTH,
            minHeight: NODE_HEIGHT,
          };
          const content = (
            <>
              <span className={styles.title}>
                {node.title || truncateText(node.preview, 48)}
              </span>
              <span className={styles.preview}>{truncateText(node.preview, 64)}</span>
              {node.branch_anchor_preview ? (
                <span className={styles.quote}>
                  {truncateText(node.branch_anchor_preview, 56)}
                </span>
              ) : null}
              <span className={styles.meta}>
                {node.child_count > 0 ? `${node.child_count} replies - ` : ""}
                {node.status} - {node.message_count}
              </span>
            </>
          );

          if (switchable) {
            return (
              <button
                key={node.id}
                type="button"
                className={styles.node}
                style={style}
                data-active={node.active_path ? "true" : "false"}
                data-match={matched ? "true" : "false"}
                aria-current={node.active_path ? "true" : undefined}
                aria-label={`Switch to graph leaf. ${label}`}
                onClick={() => onSelectLeaf(node.leaf_message_id)}
              >
                {content}
              </button>
            );
          }

          return (
            <div
              key={node.id}
              className={styles.node}
              style={style}
              data-active={node.active_path ? "true" : "false"}
              data-match={matched ? "true" : "false"}
              aria-label={label}
            >
              <GitBranch size={13} aria-hidden="true" className={styles.branchIcon} />
              {content}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function graphNodeSearchText(node: BranchGraphNode): string {
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

function graphNodeLabel(node: BranchGraphNode): string {
  return [
    node.title ? `Title: ${node.title}` : null,
    `Preview: ${node.preview}`,
    node.branch_anchor_preview ? `Quote: ${node.branch_anchor_preview}` : null,
    `Status: ${node.status}`,
    `Messages: ${node.message_count}`,
    `Created: ${dateLabel(node.created_at)}`,
    node.active_path ? "Current path" : null,
  ]
    .filter(Boolean)
    .join(". ");
}

function dateLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
