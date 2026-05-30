/**
 * MarkdownMessage — renders assistant message content as markdown.
 *
 * Uses react-markdown with GFM support and syntax highlighting.
 * Two modes: full memo for completed messages, block-split for streaming.
 */

"use client";

import {
  createContext,
  memo,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
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

type MarkdownComponents = ComponentProps<typeof ReactMarkdown>["components"];
const baseComponents: MarkdownComponents = {
  code: CodeBlock,
  pre: PreBlock,
  table: TableBlock,
  a: MarkdownLink,
};
const CitationContext = createContext<{
  citationByIndex?: Map<number, ReaderCitationData>;
  onActivate?: (target: ReaderSourceTarget) => void;
}>({});

function citationIndexFromHref(href: string | undefined): number | null {
  if (!href?.startsWith(CITATION_HREF_PREFIX)) return null;
  const index = Number(href.slice(CITATION_HREF_PREFIX.length));
  return Number.isInteger(index) && index > 0 ? index : null;
}

function substituteCitationMarkers(content: string): string {
  return content.replace(
    /\[(\d+)\](?!\()/g,
    (_match, digits) => `[${digits}](${CITATION_HREF_PREFIX}${digits})`,
  );
}

function escapeModelCitationPlaceholders(content: string): string {
  return content.replace(/<<cite:(\d+)>>/g, "\\<\\<cite:$1\\>\\>");
}

function CitationAwareLink({
  href,
  children,
  node: _node,
  ...rest
}: HTMLAttributes<HTMLAnchorElement> & {
  href?: string;
  children?: ReactNode;
  node?: unknown;
}) {
  const { citationByIndex, onActivate } = useContext(CitationContext);
  const citationIndex = citationIndexFromHref(href);
  const citation =
    citationIndex !== null ? citationByIndex?.get(citationIndex) : undefined;
  if (citation) {
    return (
      <ReaderCitation
        index={citation.index}
        color={citation.color}
        preview={citation.preview}
        target={citation.target}
        href={citation.href}
        onActivate={onActivate ?? (() => undefined)}
      />
    );
  }
  if (citationIndex !== null) {
    return null;
  }

  return <MarkdownLink href={href} {...rest}>{children}</MarkdownLink>;
}

const citationComponents: MarkdownComponents = {
  ...baseComponents,
  a: CitationAwareLink,
};

// ---------------------------------------------------------------------------
// Full render (completed messages)
// ---------------------------------------------------------------------------

function MarkdownMessageInner({
  content,
  citations,
  onCitationActivate,
}: {
  content: string;
  citations?: ReaderCitationData[];
  onCitationActivate?: (target: ReaderSourceTarget) => void;
}) {
  const citationByIndex =
    useMemo(
      () =>
        citations && citations.length > 0
          ? new Map(citations.map((c) => [c.index, c]))
          : undefined,
      [citations],
    );
  const citationContext = useMemo(
    () => ({ citationByIndex, onActivate: onCitationActivate }),
    [citationByIndex, onCitationActivate],
  );
  const renderedContent = useMemo(
    () =>
      escapeModelCitationPlaceholders(
        citationByIndex ? substituteCitationMarkers(content) : content,
      ),
    [citationByIndex, content],
  );
  const rendered = citationByIndex ? (
    <CitationContext.Provider value={citationContext}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={citationComponents}
      >
        {renderedContent}
      </ReactMarkdown>
    </CitationContext.Provider>
  ) : (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={baseComponents}
    >
      {renderedContent}
    </ReactMarkdown>
  );
  return <div className={styles.markdown}>{rendered}</div>;
}

export const MarkdownMessage = memo(MarkdownMessageInner);
