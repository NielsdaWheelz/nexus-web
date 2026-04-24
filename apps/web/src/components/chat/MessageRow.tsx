"use client";

import { AlertCircle, ExternalLink, Search } from "lucide-react";
import InlineCitations from "@/components/ui/InlineCitations";
import {
  MarkdownMessage,
  StreamingMarkdownMessage,
} from "@/components/ui/MarkdownMessage";
import { truncateText } from "@/lib/conversations/display";
import type {
  ConversationMessage,
  MessageContextSnapshot,
  MessageRetrieval,
  MessageToolCall,
} from "@/lib/conversations/types";
import styles from "./MessageRow.module.css";

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = Date.now();
  const diffSec = Math.floor((now - d.getTime()) / 1000);
  if (diffSec < 60) return "just now";
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function MessageRow({ message }: { message: ConversationMessage }) {
  const roleClass = styles[message.role] ?? "";
  const statusClass =
    message.status !== "complete" ? (styles[message.status] ?? "") : "";
  const contexts = message.contexts ?? [];
  const toolCalls = message.tool_calls ?? [];
  const selectedRetrievals = toolCalls.flatMap((toolCall) =>
    toolCall.retrievals.filter((retrieval) => retrieval.selected),
  );

  return (
    <div className={`${styles.message} ${roleClass} ${statusClass}`}>
      {message.role === "user" && contexts.length === 1 ? (
        <ReplyBar context={contexts[0]} />
      ) : null}
      {message.role === "user" && contexts.length > 1 ? (
        <InlineCitations contexts={contexts} />
      ) : null}

      {message.role === "assistant" ? (
        <>
          <ToolActivity toolCalls={toolCalls} />
          {message.status === "pending" ? (
            <StreamingMarkdownMessage content={message.content} />
          ) : (
            <MarkdownMessage content={message.content} />
          )}
          <SourceCitations retrievals={selectedRetrievals} />
        </>
      ) : (
        <span>{message.content || (message.status === "pending" ? "..." : "")}</span>
      )}

      {message.status === "error" && message.error_code ? (
        <span className={styles.messageError}>
          <AlertCircle size={14} />
          {message.error_code}
        </span>
      ) : null}

      <span className={styles.timestamp}>{formatTime(message.created_at)}</span>
    </div>
  );
}

function ToolActivity({ toolCalls }: { toolCalls: MessageToolCall[] }) {
  const active = toolCalls.find((toolCall) =>
    ["started", "pending"].includes(toolCall.status),
  );
  if (!active) return null;

  return (
    <div className={styles.toolActivity}>
      <Search size={14} />
      <span>Searching library</span>
    </div>
  );
}

function SourceCitations({ retrievals }: { retrievals: MessageRetrieval[] }) {
  if (retrievals.length === 0) return null;

  return (
    <div className={styles.sourceCitations}>
      {retrievals.map((retrieval) => {
        const citation = retrieval.result_ref;
        const href = retrieval.deep_link || citation.deep_link;
        const label = citation.title || citation.source_label || "Source";
        return (
          <a
            key={`${retrieval.result_type}-${retrieval.source_id}`}
            className={styles.sourceCitation}
            href={href}
          >
            <span>{label}</span>
            <ExternalLink size={12} />
          </a>
        );
      })}
    </div>
  );
}

export function ReplyBar({ context }: { context: MessageContextSnapshot }) {
  const text = context.exact || context.preview;
  const colorClass = styles[`replyBar-${context.color ?? ""}`] ?? "";

  return (
    <div className={`${styles.replyBar} ${colorClass}`}>
      {text ? <div>{truncateText(text, 140)}</div> : null}
      {context.annotation_body ? (
        <div className={styles.replyBarAnnotation}>{context.annotation_body}</div>
      ) : null}
      {!text && !context.annotation_body && context.media_title ? (
        <div>{context.media_title}</div>
      ) : null}
    </div>
  );
}
