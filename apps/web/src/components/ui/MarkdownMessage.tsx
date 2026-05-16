/**
 * MarkdownMessage — renders assistant message content as markdown.
 *
 * Uses react-markdown with GFM support and syntax highlighting.
 * Two modes: full memo for completed messages, block-split for streaming.
 */

"use client";

import {
  memo,
  useState,
  useCallback,
  useRef,
  type ReactNode,
  type HTMLAttributes,
  type ComponentProps,
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
const CITATION_HREF_PREFIX = "#nexus-reader-citation-";

export interface ReaderCitationData {
  index: number;
  color: ReaderCitationColor;
  preview: ReaderCitationPreview;
  target: ReaderSourceTarget | null;
  href?: string | null;
}

export interface ReaderCitationRange {
  start: number;
  end: number;
  citation: ReaderCitationData;
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
  const position = (
    _node as
      | { position?: { start?: { line?: number }; end?: { line?: number } } }
      | undefined
  )?.position;
  const startLine = position?.start?.line;
  const endLine = position?.end?.line;
  const isBlock =
    typeof startLine === "number" &&
    typeof endLine === "number" &&
    endLine > startLine;

  if (!match && !isBlock) {
    return <code className={styles.inlineCode} {...rest}>{children}</code>;
  }

  return (
    <CodeBlockWrapper language={match?.[1] ?? "text"}>
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

function TableBlock({
  children,
  node: _node,
  ...rest
}: HTMLAttributes<HTMLTableElement> & { children?: ReactNode; node?: unknown }) {
  return (
    <div className={styles.tableScroll} data-testid="markdown-table-scroll">
      <table {...rest}>{children}</table>
    </div>
  );
}

function MarkdownLink({
  href,
  children,
  node: _node,
  ...rest
}: HTMLAttributes<HTMLAnchorElement> & {
  href?: string;
  children?: ReactNode;
  node?: unknown;
}) {
  if (!href) return <>{children}</>;
  return <a href={href} {...rest}>{children}</a>;
}

const baseComponents = { code: CodeBlock, pre: PreBlock, table: TableBlock, a: MarkdownLink };
type MarkdownComponents = ComponentProps<typeof ReactMarkdown>["components"];

function citationHref(index: number): string {
  return `${CITATION_HREF_PREFIX}${index}`;
}

function citationIndexFromHref(href: string | undefined): number | null {
  if (!href?.startsWith(CITATION_HREF_PREFIX)) return null;
  const index = Number(href.slice(CITATION_HREF_PREFIX.length));
  return Number.isInteger(index) && index > 0 ? index : null;
}

function contentWithCitationMarkers(
  content: string,
  citationRanges: ReaderCitationRange[],
): string {
  const sortedRanges = [...citationRanges].sort((a, b) => a.end - b.end);
  let cursor = 0;
  let lastCitationEnd = 0;
  let nextContent = "";

  for (const range of sortedRanges) {
    if (
      range.start < lastCitationEnd ||
      range.end <= range.start ||
      range.end > content.length
    ) {
      continue;
    }
    nextContent += content.slice(cursor, range.end);
    nextContent += `[${range.citation.index}](${citationHref(range.citation.index)})`;
    cursor = range.end;
    lastCitationEnd = range.end;
  }

  return nextContent + content.slice(cursor);
}

function escapeModelCitationPlaceholders(content: string): string {
  return content.replace(/<<cite:(\d+)>>/g, "\\<\\<cite:$1\\>\\>");
}

function createMarkdownComponents({
  citationByIndex,
  onActivate,
  onAskAboutSource,
  onSaveSourceQuote,
}: {
  citationByIndex?: Map<number, ReaderCitationData>;
  onActivate?: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
}): MarkdownComponents {
  if (!citationByIndex) return baseComponents;
  const citations = citationByIndex;

  function LinkBlock({
    href,
    children,
    node: _node,
    ...rest
  }: HTMLAttributes<HTMLAnchorElement> & {
    href?: string;
    children?: ReactNode;
    node?: unknown;
  }) {
    const citationIndex = citationIndexFromHref(href);
    const citation =
      citationIndex !== null ? citations.get(citationIndex) : undefined;
    if (citation) {
      return (
        <ReaderCitation
          index={citation.index}
          color={citation.color}
          preview={citation.preview}
          target={citation.target}
          href={citation.href}
          onActivate={onActivate ?? (() => undefined)}
          onAskAboutSource={onAskAboutSource}
          onSaveSourceQuote={onSaveSourceQuote}
        />
      );
    }

    return <MarkdownLink href={href} {...rest}>{children}</MarkdownLink>;
  }

  return { ...baseComponents, a: LinkBlock };
}

// ---------------------------------------------------------------------------
// Full render (completed messages)
// ---------------------------------------------------------------------------

function renderWithCitations(
  content: string,
  citationRanges: ReaderCitationRange[] | undefined,
  onActivate: ((target: ReaderSourceTarget) => void) | undefined,
  onAskAboutSource: ((target: ReaderSourceTarget) => void) | undefined,
  onSaveSourceQuote: ((target: ReaderSourceTarget) => void) | undefined,
): ReactNode {
  if (citationRanges && citationRanges.length > 0) {
    const citationByIndex = new Map(
      citationRanges.map((range) => [range.citation.index, range.citation]),
    );
    return (
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={createMarkdownComponents({
          citationByIndex,
          onActivate,
          onAskAboutSource,
          onSaveSourceQuote,
        })}
      >
        {escapeModelCitationPlaceholders(
          contentWithCitationMarkers(content, citationRanges),
        )}
      </ReactMarkdown>
    );
  }

  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={baseComponents}
    >
      {escapeModelCitationPlaceholders(content)}
    </ReactMarkdown>
  );
}

function MarkdownMessageInner({
  content,
  citationRanges,
  onCitationActivate,
  onAskAboutSource,
  onSaveSourceQuote,
}: {
  content: string;
  citationRanges?: ReaderCitationRange[];
  onCitationActivate?: (target: ReaderSourceTarget) => void;
  onAskAboutSource?: (target: ReaderSourceTarget) => void;
  onSaveSourceQuote?: (target: ReaderSourceTarget) => void;
}) {
  return (
    <div className={styles.markdown}>
      {renderWithCitations(
        content,
        citationRanges,
        onCitationActivate,
        onAskAboutSource,
        onSaveSourceQuote,
      )}
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
      components={baseComponents}
    >
      {escapeModelCitationPlaceholders(content)}
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
        components={baseComponents}
      >
        {escapeModelCitationPlaceholders(active)}
      </ReactMarkdown>
    </div>
  );
}
