/**
 * MarkdownMessage — renders assistant message content as markdown.
 *
 * Uses react-markdown with GFM support and syntax highlighting.
 * Two modes: full memo for completed messages, block-split for streaming.
 */

"use client";

import {
  Fragment,
  memo,
  useState,
  useCallback,
  useRef,
  type ReactNode,
  type HTMLAttributes,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import ReaderCitation, {
  type ReaderCitationColor,
  type ReaderCitationPreview,
} from "@/components/ui/ReaderCitation";
import type { ReaderSourceTarget } from "@/components/chat/MessageRow";
import "./hljs-theme.css";
import styles from "./MarkdownMessage.module.css";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

export interface ReaderCitationData {
  index: number;
  color: ReaderCitationColor;
  preview: ReaderCitationPreview;
  target: ReaderSourceTarget | null;
}

const CITATION_PLACEHOLDER = /<<cite:(\d+)>>/g;

function splitContentIntoSegments(
  content: string,
): Array<{ kind: "text"; value: string } | { kind: "citation"; index: number }> {
  const segments: Array<
    { kind: "text"; value: string } | { kind: "citation"; index: number }
  > = [];
  let cursor = 0;
  for (const match of content.matchAll(CITATION_PLACEHOLDER)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      segments.push({ kind: "text", value: content.slice(cursor, start) });
    }
    segments.push({ kind: "citation", index: Number(match[1]) });
    cursor = start + match[0].length;
  }
  if (cursor < content.length) {
    segments.push({ kind: "text", value: content.slice(cursor) });
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Code block with language label + copy button
// ---------------------------------------------------------------------------

function CodeBlock({
  className,
  children,
  node: _node,
  ...rest
}: HTMLAttributes<HTMLElement> & { children?: ReactNode; node?: unknown }) {
  const match = /language-(\w+)/.exec(className ?? "");

  if (!match) {
    return <code className={styles.inlineCode} {...rest}>{children}</code>;
  }

  return (
    <CodeBlockWrapper language={match[1]}>
      <code className={className} {...rest}>{children}</code>
    </CodeBlockWrapper>
  );
}

function CodeBlockWrapper({
  language,
  children,
}: {
  language: string;
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(() => {
    const text = contentRef.current?.textContent ?? "";
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, []);

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span>{language}</span>
        <button type="button" className={styles.copyBtn} onClick={handleCopy}>
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div
        ref={contentRef}
        className={styles.codeBlockContent}
        data-lang={language}
      >
        {children}
      </div>
    </div>
  );
}

// Wrap <pre> to avoid double-nesting from react-markdown
function PreBlock({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

const components = { code: CodeBlock, pre: PreBlock };

// ---------------------------------------------------------------------------
// Full render (completed messages)
// ---------------------------------------------------------------------------

function renderWithCitations(
  content: string,
  citations: ReaderCitationData[] | undefined,
  onActivate: ((target: ReaderSourceTarget) => void) | undefined,
): ReactNode {
  if (!citations || citations.length === 0 || !content.includes("<<cite:")) {
    return (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
    );
  }
  const byIndex = new Map(citations.map((entry) => [entry.index, entry]));
  const segments = splitContentIntoSegments(content);
  return segments.map((segment, position) => {
    if (segment.kind === "text") {
      return (
        <ReactMarkdown
          key={position}
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={components}
        >
          {segment.value}
        </ReactMarkdown>
      );
    }
    const data = byIndex.get(segment.index);
    if (!data) return <Fragment key={position} />;
    return (
      <ReaderCitation
        key={position}
        index={data.index}
        color={data.color}
        preview={data.preview}
        target={data.target}
        onActivate={onActivate ?? (() => undefined)}
      />
    );
  });
}

function MarkdownMessageInner({
  content,
  citations,
  onCitationActivate,
}: {
  content: string;
  citations?: ReaderCitationData[];
  onCitationActivate?: (target: ReaderSourceTarget) => void;
}) {
  return (
    <div className={styles.markdown}>
      {renderWithCitations(content, citations, onCitationActivate)}
    </div>
  );
}

export const MarkdownMessage = memo(MarkdownMessageInner);

// ---------------------------------------------------------------------------
// Streaming render — memoize all blocks except the last
// ---------------------------------------------------------------------------

const SettledBlock = memo(function SettledBlock({ content }: { content: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});

export function StreamingMarkdownMessage({ content }: { content: string }) {
  if (!content) return null;

  const blocks = content.split(/\n\n/);
  const settled = blocks.slice(0, -1);
  const active = blocks[blocks.length - 1];

  return (
    <div className={styles.markdown}>
      {settled.map((block, i) => (
        <SettledBlock key={i} content={block} />
      ))}
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {active}
      </ReactMarkdown>
    </div>
  );
}
