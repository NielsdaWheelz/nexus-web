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
import { copyText } from "@/lib/ui/copyText";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];
const CITATION_HREF_PREFIX = "#nexus-reader-citation-";

interface MarkdownFindRange {
  readonly start: number;
  readonly end: number;
  readonly blockIndex: number;
  readonly locatorStart: number;
  readonly locatorEnd: number;
}

interface FindPositionedNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: FindPositionedNode[];
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

function rehypeFindMark({
  renderedRange,
  locator,
}: {
  readonly renderedRange: MarkdownFindRange;
  readonly locator: MarkdownFindRange;
}) {
  return () => (tree: FindPositionedNode) => {
    const visit = (node: FindPositionedNode) => {
      if (!node.children) return;
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index]!;
        const startOffset = child.position?.start?.offset;
        const endOffset = child.position?.end?.offset;
        if (
          child.type === "text" &&
          typeof child.value === "string" &&
          typeof startOffset === "number" &&
          typeof endOffset === "number" &&
          renderedRange.start >= startOffset &&
          renderedRange.end <= endOffset
        ) {
          const relativeStart = renderedRange.start - startOffset;
          const relativeEnd = renderedRange.end - startOffset;
          node.children.splice(
            index,
            1,
            {
              type: "text",
              value: child.value.slice(0, relativeStart),
            },
            {
              type: "element",
              tagName: "mark",
              properties: {
                className: [styles.findMark],
                "data-find-active-mark": "true",
                "data-find-block-index": locator.blockIndex,
                "data-find-start": locator.locatorStart,
                "data-find-end": locator.locatorEnd,
                "aria-label": "Current match",
              },
              children: [
                {
                  type: "text",
                  value: child.value.slice(relativeStart, relativeEnd),
                },
              ],
            },
            {
              type: "text",
              value: child.value.slice(relativeEnd),
            },
          );
          return;
        }
        visit(child);
      }
    };
    visit(tree);
  };
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
  const [copyState, setCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  const contentRef = useRef<HTMLDivElement>(null);

  const handleCopy = useCallback(async () => {
    const text = contentRef.current?.textContent ?? "";
    try {
      await copyText(text);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    setTimeout(() => setCopyState("idle"), 1500);
  }, []);

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
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

function replaceMarkdownWithRange({
  content,
  range,
  pattern,
  replacement,
}: {
  readonly content: string;
  readonly range: MarkdownFindRange | null;
  readonly pattern: RegExp;
  readonly replacement: (match: RegExpExecArray) => string;
}): { readonly content: string; readonly range: MarkdownFindRange | null } {
  pattern.lastIndex = 0;
  let cursor = 0;
  let rendered = "";
  let offsetShift = 0;
  let renderableRange = range;
  for (let match = pattern.exec(content); match; match = pattern.exec(content)) {
    const matched = match[0];
    const next = replacement(match);
    rendered += content.slice(cursor, match.index);
    rendered += next;
    const matchEnd = match.index + matched.length;
    if (renderableRange && matchEnd <= range!.start) {
      offsetShift += next.length - matched.length;
    } else if (
      renderableRange &&
      match.index < range!.end &&
      matchEnd > range!.start
    ) {
      renderableRange = null;
    }
    cursor = matchEnd;
  }
  rendered += content.slice(cursor);
  return {
    content: rendered,
    range: renderableRange
      ? {
          ...renderableRange,
          start: renderableRange.start + offsetShift,
          end: renderableRange.end + offsetShift,
        }
      : null,
  };
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
  findRange = null,
}: {
  content: string;
  citations?: ReaderCitationData[];
  onCitationActivate?: (
    activation: ResourceActivation,
    target: ReaderSourceTarget | null,
    event?: React.MouseEvent,
  ) => void;
  findRange?: MarkdownFindRange | null;
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
      ? replaceMarkdownWithRange({
          content,
          range: findRange,
          pattern: /\[(\d+)\](?!\()/g,
          replacement: (match) =>
            `[${match[1]}](${CITATION_HREF_PREFIX}${match[1]})`,
        })
      : { content, range: findRange };
    return replaceMarkdownWithRange({
      content: withCitations.content,
      range: withCitations.range,
      pattern: /<<cite:(\d+)>>/g,
      replacement: (match) => `\\<\\<cite:${match[1]}\\>\\>`,
    });
  }, [citationByIndex, content, findRange]);
  const renderedContent = rendered.content;
  const renderedFindRange = rendered.range;
  const activeRehypePlugins = useMemo(
    () =>
      renderedFindRange && findRange
        ? [
            ...rehypePlugins,
            rehypeFindMark({
              renderedRange: renderedFindRange,
              locator: findRange,
            }),
          ]
        : rehypePlugins,
    [findRange, renderedFindRange],
  );
  const markdown = (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={activeRehypePlugins}
      components={citationByIndex ? citationComponents : baseComponents}
    >
      {renderedContent}
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
