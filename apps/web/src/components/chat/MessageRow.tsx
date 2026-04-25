"use client";

import { AlertCircle, ExternalLink, Globe, Search } from "lucide-react";
import InlineCitations from "@/components/ui/InlineCitations";
import {
  MarkdownMessage,
  StreamingMarkdownMessage,
} from "@/components/ui/MarkdownMessage";
import {
  getWebCitationKey,
  isWebCitation,
  toWebCitationChipData,
  type WebCitationChipData,
} from "@/lib/chat/citations";
import { truncateText } from "@/lib/conversations/display";
import type {
  ConversationMessage,
  MessageContextSnapshot,
  MessageRetrieval,
  MessageToolCall,
} from "@/lib/conversations/types";
import styles from "./MessageRow.module.css";

type MessageWithWebCitations = ConversationMessage & {
  citations?: WebCitationChipData[];
};

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
  const webCitations = (message as MessageWithWebCitations).citations ?? [];

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
          <SourceCitations
            retrievals={selectedRetrievals}
            webCitations={webCitations}
          />
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
  const label = active.tool_name === "web_search" ? "Searching web" : "Searching library";

  return (
    <div className={styles.toolActivity}>
      <Search size={14} />
      <span>{label}</span>
    </div>
  );
}

function SourceCitations({
  retrievals,
  webCitations,
}: {
  retrievals: MessageRetrieval[];
  webCitations: WebCitationChipData[];
}) {
  if (retrievals.length === 0 && webCitations.length === 0) return null;

  return (
    <div className={styles.sourceCitations}>
      {webCitations.map((citation, index) => {
        const label = citation.title || citation.source_name || citation.display_url || "Web";
        const meta = citation.source_name || citation.display_url;
        return (
          <a
            key={getWebCitationKey(citation, index)}
            className={`${styles.sourceCitation} ${styles.webCitation}`}
            href={citation.url}
            target="_blank"
            rel="noreferrer"
            title={citation.snippet ?? label}
          >
            <Globe size={12} />
            <span>{label}</span>
            {meta && meta !== label ? (
              <span className={styles.citationMeta}>{meta}</span>
            ) : null}
            <ExternalLink size={12} />
          </a>
        );
      })}
      {retrievals.map((retrieval) => {
        const citation = retrieval.result_ref;
        if (isWebCitation(citation)) {
          const webCitation = toWebCitationChipData(citation);
          const label =
            webCitation.title ||
            webCitation.source_name ||
            webCitation.display_url ||
            "Web";
          const meta = webCitation.source_name || webCitation.display_url;
          return (
            <a
              key={`${retrieval.result_type}-${retrieval.source_id}`}
              className={`${styles.sourceCitation} ${styles.webCitation}`}
              href={webCitation.url}
              target="_blank"
              rel="noreferrer"
              title={webCitation.snippet ?? label}
            >
              <Globe size={12} />
              <span>{label}</span>
              {meta && meta !== label ? (
                <span className={styles.citationMeta}>{meta}</span>
              ) : null}
              <ExternalLink size={12} />
            </a>
          );
        }
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
