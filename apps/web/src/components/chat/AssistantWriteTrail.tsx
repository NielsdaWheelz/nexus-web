"use client";

import { useState } from "react";
import { undoToolCall } from "@/lib/conversations/toolCallUndo";
import type { MessageToolCall } from "@/lib/conversations/types";
import styles from "./MessageRow.module.css";

const WRITE_TOOL_NAMES = new Set([
  "add_to_library",
  "jot_note",
  "create_highlight",
  "mint_edge",
  "queue_add",
]);

function truncate(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;
}

function describeWrite(tool: MessageToolCall): {
  kicker: string;
  target: string;
  detail?: string;
} {
  const refs = tool.result_refs ?? [];
  const labeledRef = refs.find((ref) =>
    typeof ref.label === "string" && ref.label.trim(),
  );
  const label = typeof labeledRef?.label === "string" ? labeledRef.label : "";
  const stringAt = (ref: Record<string, unknown>, key: string) =>
    typeof ref[key] === "string" ? ref[key].trim() : "";

  switch (tool.tool_name) {
    case "add_to_library":
      return { kicker: "Filed to", target: label || "library" };
    case "create_highlight":
      return {
        kicker: "Highlighted",
        target: label ? `“${truncate(label)}”` : "passage",
      };
    case "mint_edge": {
      const edge = refs.find((ref) => ref.kind === "edge");
      const source = edge
        ? stringAt(edge as Record<string, unknown>, "source_label")
        : "";
      const target = edge
        ? stringAt(edge as Record<string, unknown>, "target_label")
        : "";
      if (source && target) {
        const detail = truncate(
          stringAt(edge as Record<string, unknown>, "rationale"),
          100,
        );
        return {
          kicker: "Connected",
          target: `${source} ↔ ${target}`,
          detail: detail || undefined,
        };
      }
      return { kicker: "Connected", target: label || "two resources" };
    }
    case "jot_note":
      return { kicker: "Noted in", target: label || "note" };
    case "queue_add":
      return { kicker: "Queued", target: label || "item" };
    default:
      return { kicker: tool.tool_name, target: label };
  }
}

export default function AssistantWriteTrail({
  conversationId,
  toolCalls,
}: {
  conversationId: string;
  toolCalls: MessageToolCall[];
}) {
  const writes = toolCalls.filter((tool) =>
    Boolean(tool.id) &&
    WRITE_TOOL_NAMES.has(tool.tool_name) &&
    tool.status === "complete",
  );
  const [reverted, setReverted] = useState(
    () =>
      new Set(
        writes
          .filter((tool) => tool.reverted_at)
          .map((tool) => tool.id as string),
      ),
  );
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  if (writes.length === 0) return null;

  const undo = async (toolCallId: string) => {
    setBusy((previous) => new Set(previous).add(toolCallId));
    try {
      await undoToolCall(conversationId, toolCallId);
      setReverted((previous) => new Set(previous).add(toolCallId));
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(toolCallId);
        return next;
      });
    }
  };

  return (
    <div className={styles.writeTrail} role="list" aria-label="Assistant actions">
      {writes.map((tool) => {
        const id = tool.id as string;
        const { kicker, target, detail } = describeWrite(tool);
        const isReverted = reverted.has(id) || Boolean(tool.reverted_at);
        return (
          <div key={id} className={styles.writeRow} role="listitem">
            <span className={styles.writeKicker}>{kicker}</span>
            <span className={styles.writeVerb}>
              <em>{target}</em>
              {detail ? (
                <span className={styles.writeDetail}>{detail}</span>
              ) : null}
            </span>
            {isReverted ? (
              <span className={styles.writeUndone}>Undone</span>
            ) : (
              <button
                type="button"
                className={styles.writeUndo}
                disabled={busy.has(id)}
                onClick={() => void undo(id)}
                aria-label={`Undo: ${kicker} ${target}`}
              >
                Undo
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
