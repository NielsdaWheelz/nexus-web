"use client";

import { useState } from "react";
import { undoToolCall } from "@/lib/conversations/toolCallUndo";
import type { MessageToolCall } from "@/lib/conversations/types";
import styles from "./MessageRow.module.css";

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

  const kind = refs.find((ref) => typeof ref.kind === "string")?.kind;
  switch (kind) {
    case "entry":
      return { kicker: "Filed to", target: label || "library" };
    case "highlight":
      return {
        kicker: "Highlighted",
        target: label ? `“${truncate(label)}”` : "passage",
      };
    case "edge": {
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
    case "note_block":
      return { kicker: "Noted in", target: label || "note" };
    case "queue":
      return { kicker: "Queued", target: label || "item" };
    default:
      return {
        kicker: "Assistant action",
        target: label || tool.activity_label,
      };
  }
}

export default function AssistantWriteTrail({
  conversationId,
  toolCalls,
}: {
  conversationId: string;
  toolCalls: MessageToolCall[];
}) {
  const writes = toolCalls.filter(
    (tool) =>
      Boolean(tool.id) &&
      tool.effect === "Write" &&
      tool.result_kind === "mutation" &&
      tool.status === "complete" &&
      tool.machine_authorships !== undefined,
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
        const authorship = tool.machine_authorships?.[0] ?? null;
        if (tool.result_refs.length > 0 && authorship === null) {
          throw new Error(
            "Successful assistant write lacks proven machine authorship",
          );
        }
        const isReverted = reverted.has(id) || Boolean(tool.reverted_at);
        return (
          <div key={id} className={styles.writeRow} role="listitem">
            <span className={styles.writeKicker}>{kicker}</span>
            <span className={styles.writeVerb}>
              <em>{target}</em>
              {detail ? (
                <span className={styles.writeDetail}>{detail}</span>
              ) : null}
              <span className={styles.writeAuthorship}>
                {authorship
                  ? `Assistant-created · ${authorship.position_path}`
                  : "No new target created"}
              </span>
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
