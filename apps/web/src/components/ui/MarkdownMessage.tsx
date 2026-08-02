/**
 * MarkdownMessage — renders assistant message content as markdown.
 *
 * Uses react-markdown with GFM support and syntax highlighting. Memoized so a
 * completed message re-parses only when its content or citations change; only
 * the one actively streaming message re-parses, per coalesced delta flush.
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
import ReaderCitation from "@/components/ui/ReaderCitation";
import type { ReaderCitationData } from "@/lib/conversations/readerCitation";
import type { ReaderSourceTarget } from "@/lib/conversations/readerTarget";
import type { ResourceActivation } from "@/lib/resources/activation";
import "./hljs-theme.css";
import styles from "./MarkdownMessage.module.css";
import {
  ClipboardWriteUnavailableError,
  copyText,
} from "@/lib/ui/copyText";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];
const CITATION_HREF_PREFIX = "#nexus-reader-citation-";

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
  const [copyState, setCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const [copyDefect, setCopyDefect] = useState<{ error: unknown } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(async () => {
    const text = contentRef.current?.textContent ?? "";
    try {
      await copyText(text);
      setCopyState("copied");
    } catch (error) {
      if (!(error instanceof ClipboardWriteUnavailableError)) {
        setCopyDefect({ error });
        return;
      }
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 1500);
  }, []);

  if (copyDefect !== null) throw copyDefect.error;

  return (
    <div className={styles.codeBlock}>
      <div
        className={styles.codeBlockHeader}
        data-pane-find-exclude="true"
      >
        <span>{language}</span>
        <button type="button" className={styles.copyBtn} onClick={() => void handleCopy()}>
          {copyState === "copied"
            ? "copied"
            : copyState === "failed"
              ? "copy failed"
              : "copy"}
        </button>
      </div>
      <div
        ref={contentRef}
        className={styles.codeBlockContent}
        data-pane-find-code-scroll="true"
        data-lang={language}
        data-testid="markdown-code-scroll"
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
  onActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
}>({});

function citationIndexFromHref(href: string | undefined): number | null {
  if (!href?.startsWith(CITATION_HREF_PREFIX)) return null;
  const index = Number(href.slice(CITATION_HREF_PREFIX.length));
  return Number.isInteger(index) && index > 0 ? index : null;
}

function replaceMarkdown({
  content,
  pattern,
  replacement,
}: {
  readonly content: string;
  readonly pattern: RegExp;
  readonly replacement: (match: RegExpExecArray) => string;
}): string {
  pattern.lastIndex = 0;
  let cursor = 0;
  let rendered = "";
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    const matched = match[0];
    const next = replacement(match);
    rendered += content.slice(cursor, match.index);
    rendered += next;
    cursor = match.index + matched.length;
  }
  rendered += content.slice(cursor);
  return rendered;
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
        preview={citation.preview}
        activation={citation.activation}
        target={citation.target}
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
  onCitationActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
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
  const rendered = useMemo(() => {
    const withCitations = citationByIndex
      ? replaceMarkdown({
          content,
          pattern: /\[(\d+)\](?!\()/g,
          replacement: (match) =>
            `[${match[1]}](${CITATION_HREF_PREFIX}${match[1]})`,
        })
      : content;
    return replaceMarkdown({
      content: withCitations,
      pattern: /<<cite:(\d+)>>/g,
      replacement: (match) => `\\<\\<cite:${match[1]}\\>\\>`,
    });
  }, [citationByIndex, content]);
  const markdown = (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={citationByIndex ? citationComponents : baseComponents}
    >
      {rendered}
    </ReactMarkdown>
  );
  return (
    <div className={styles.markdown}>
      {citationByIndex ? (
        <CitationContext.Provider value={citationContext}>
          {markdown}
        </CitationContext.Provider>
      ) : (
        markdown
      )}
    </div>
  );
}

export const MarkdownMessage = memo(MarkdownMessageInner);
