"use client";

import {
  createContext,
  memo,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type MouseEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type {
  ReaderCitationData,
  ReaderSourceTarget,
} from "@/lib/resourceGraph/citations";
import type { ResourceActivation } from "@/lib/resources/activation";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import ReaderCitation from "./ReaderCitation";
import "./hljs-theme.css";
import styles from "./MarkdownMessage.module.css";

type OnCitationActivate = (
  activation: ResourceActivation,
  target: ReaderSourceTarget | null,
  event?: MouseEvent,
) => void;
type Components = ComponentProps<typeof ReactMarkdown>["components"];
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

const CITATION_HREF = "#nexus-reader-citation-";

/**
 * `[n]` in prose becomes a citation link; code, inline code and link text are
 * not prose, so they keep it verbatim. The link renders as the citation when n
 * is one, else as the original `[n]`.
 */
function remarkCitations() {
  const split = (value: string): MdNode[] =>
    value.split(/(\[\d+\])/).flatMap((part): MdNode[] => {
      const n = /^\[(\d+)\]$/.exec(part)?.[1];
      if (n)
        return [
          {
            type: "link",
            url: `${CITATION_HREF}${n}`,
            children: [{ type: "text", value: part }],
          },
        ];
      return part ? [{ type: "text", value: part }] : [];
    });
  const walk = (node: MdNode) => {
    if (!node.children || node.type === "link" || node.type === "linkReference")
      return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return split(child.value ?? "");
      walk(child);
      return [child];
    });
  };
  return walk;
}

const CitationContext = createContext<{
  byIndex: Map<number, ReaderCitationData>;
  onActivate?: OnCitationActivate;
} | null>(null);

function Link({
  href,
  children,
  node: _node,
  ...rest
}: ComponentProps<"a"> & { node?: unknown }) {
  const citations = useContext(CitationContext);
  if (citations && href?.startsWith(CITATION_HREF)) {
    const citation = citations.byIndex.get(
      Number(href.slice(CITATION_HREF.length)),
    );
    if (!citation) return <>{children}</>;
    return (
      <ReaderCitation
        {...citation}
        onActivate={citations.onActivate ?? (() => undefined)}
      />
    );
  }
  if (!href) return <>{children}</>;
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

function Code({
  className,
  children,
  node,
  ...rest
}: ComponentProps<"code"> & {
  node?: { position?: { start: { line: number }; end: { line: number } } };
}) {
  const language = /language-(\w+)/.exec(className ?? "")?.[1];
  const block =
    node?.position !== undefined &&
    node.position.end.line > node.position.start.line;
  if (!language && !block) {
    return (
      <code className={styles.inlineCode} {...rest}>
        {children}
      </code>
    );
  }
  return (
    <CodeBlock language={language ?? "text"}>
      <code className={className} {...rest}>
        {children}
      </code>
    </CodeBlock>
  );
}

function CodeBlock({
  language,
  children,
}: {
  language: string;
  children: ReactNode;
}) {
  const [copy, setCopy] = useState<"copy" | "copied" | "copy failed">("copy");
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const content = useRef<HTMLDivElement>(null);
  if (defect) throw defect.error;
  const onCopy = () =>
    copyText(content.current?.textContent ?? "")
      .then(
        () => setCopy("copied"),
        (error: unknown) =>
          error instanceof ClipboardWriteUnavailableError
            ? setCopy("copy failed")
            : setDefect({ error }),
      )
      .then(() => setTimeout(() => setCopy("copy"), 1500));
  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeHeader} data-pane-find-exclude="true">
        <span>{language}</span>
        <button
          type="button"
          className={styles.copy}
          onClick={() => void onCopy()}
        >
          {copy}
        </button>
      </div>
      <div
        ref={content}
        className={styles.codeContent}
        data-pane-find-code-scroll="true"
        data-lang={language}
      >
        <pre>{children}</pre>
      </div>
    </div>
  );
}

const components: Components = {
  code: Code,
  // The code block draws its own frame and its own <pre>.
  pre: ({ children }) => <>{children}</>,
  table: ({ node: _node, ...props }) => (
    <div className={styles.tableScroll}>
      <table {...props} />
    </div>
  ),
  a: Link,
};

/**
 * Assistant markdown: gfm, highlighted code with a language label and copy,
 * tables that scroll, and, given `citations`, `[n]` marks that open their sources.
 * Memoized: a settled message re-renders only when its content or citations change.
 */
export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  citations,
  onCitationActivate,
  presentation,
}: {
  content: string;
  citations?: ReaderCitationData[];
  onCitationActivate?: OnCitationActivate;
  presentation?: "chat";
}) {
  const cited = useMemo(
    () =>
      citations?.length
        ? {
            byIndex: new Map(citations.map((c) => [c.index, c])),
            onActivate: onCitationActivate,
          }
        : null,
    [citations, onCitationActivate],
  );
  return (
    <div className={presentation === "chat" ? `${styles.markdown} ${styles.chat}` : styles.markdown}>
      <CitationContext value={cited}>
        <ReactMarkdown
          remarkPlugins={cited ? [remarkGfm, remarkCitations] : [remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={components}
        >
          {content}
        </ReactMarkdown>
      </CitationContext>
    </div>
  );
});

/** A saved answer excerpt: the same parser, with no interactive or fetched content. */
export const MarkdownPreview = memo(function MarkdownPreview({ content }: { content: string }) {
  return (
    <span className={styles.preview}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkPreview]}
        components={{ p: ({ children }) => <>{children}</> }}
      >
        {content}
      </ReactMarkdown>
    </span>
  );
});

/** A prompt excerpt keeps user text literal. It never passes through markdown. */
export function TextPreview({ content }: { content: string }) {
  return <span className={styles.preview}>{previewText(content)}</span>;
}

function remarkPreview() {
  return (tree: MdNode) => {
    const text = (node: MdNode & { alt?: string }): string => {
      if (node.type === "html" || node.type.endsWith("Definition") || node.type === "definition") return "";
      if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
      if (node.type === "code") return `${node.value ?? ""} `;
      if (node.value !== undefined) return node.value;
      if (node.type === "break" || node.type === "thematicBreak") return " ";
      const value = (node.children ?? []).map(text).join("");
      return /^(paragraph|heading|blockquote|listItem|code|tableCell|tableRow)$/.test(node.type) ? `${value} ` : value;
    };
    const preview = previewText(text(tree));
    tree.children = [{ type: "paragraph", children: [{ type: "text", value: preview }] }];
  };
}

function previewText(text: string): string {
  const value = text.replace(/\s+/g, " ").trim();
  const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value);
  const excerpt: string[] = [];
  for (const segment of segments) {
    if (excerpt.length === 240) { excerpt[239] = "…"; break; }
    excerpt.push(segment.segment);
  }
  return excerpt.join("");
}
