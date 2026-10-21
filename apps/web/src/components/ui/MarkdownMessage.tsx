"use client";

import {
  createContext,
  memo,
  useContext,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { remarkCitations } from "@/lib/chat/markdownCitations";
import type {
  ReaderCitationData,
} from "@/lib/resourceGraph/citations";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import ReaderCitation from "./ReaderCitation";
import "./hljs-theme.css";
import styles from "./MarkdownMessage.module.css";

type Components = ComponentProps<typeof ReactMarkdown>["components"];
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

const CitationContext = createContext<{
  byIndex: Map<string, ReaderCitationData>;
} | null>(null);

function Link({
  href,
  children,
  node,
  ...rest
}: ComponentProps<"a"> & ExtraProps) {
  const citations = useContext(CitationContext);
  const ordinal = node?.properties["data-nexus-citation"];
  if (citations && typeof ordinal === "string") {
    const citation = citations.byIndex.get(ordinal);
    if (!citation) return <>{children}</>;
    return (
      <ReaderCitation
        {...citation}
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
  presentation,
}: {
  content: string;
  citations?: ReaderCitationData[];
  presentation?: "chat";
}) {
  const cited = useMemo(
    () =>
      citations?.length
        ? {
            byIndex: new Map(citations.map((c) => [String(c.index), c])),
          }
        : null,
    [citations],
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
