"use client";

import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import type { Element, Root } from "hast";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { remarkCitations } from "@/lib/chat/markdownCitations";
import { rehypeMessagePassages, remarkMessagePassages, type MarkdownPassage } from "@/lib/chat/markdownPassages";
import type { Schema } from "@/lib/api/wire";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
import { useHoverPreview } from "@/components/ui/HoverPreview";
import Button from "@/components/ui/Button";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import { usePaneIsActive, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { cx } from "@/lib/ui/cx";
import { RetrievalReference } from "./LiveReference";
import ReferenceFigure from "./ReferenceFigure";
import "./hljs-theme.css";
import * as Icon from "@/lib/ui/icons";
import { useOutcome } from "@/components/feedback/Feedback";
import { Announcement } from "@/components/feedback/Announcement";
import styles from "./MarkdownMessage.module.css";
import numeral from "@/components/ui/ReaderCitation.module.css";

type Components = ComponentProps<typeof ReactMarkdown>["components"];
type MdNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MdNode[];
};

const CitationContext = createContext<{
  byIndex: Map<string, Schema<"ChatCitationOut">>;
  preview: boolean;
} | null>(null);

function subscribePreviewInput(changed: () => void) {
  const query = matchMedia("(hover: hover) and (pointer: fine)");
  query.addEventListener("change", changed);
  return () => query.removeEventListener("change", changed);
}

function Citation({ citation, adjacent, preview }: { citation: Schema<"ChatCitationOut">; adjacent: boolean; preview: boolean }) {
  const runtime = usePaneRuntime();
  const hover = useHoverPreview(preview, `citation ${citation.ordinal} preview`);
  const close = hover.close;
  useLayoutEffect(() => close({ restoreFocus: false }), [close, runtime?.href, runtime?.visitId, runtime?.paneEntryDelivery?.activationId]);
  const body = hover.render(<div className={styles.previewReference} data-type-role="margin">
    <ReferenceFigure value={citation} className={styles.previewFigure} data-reference-corresponding="" />
  </div>);
  return <>
    <sup className={cx(numeral.citation, styles.citation)} data-citation-id={citation.id} data-pane-find-exclude="true"
      data-citation-adjacent={adjacent || undefined} data-preview-open={body !== null || undefined}>
      <RetrievalReference retrieval={citation} label={String(citation.ordinal)} trigger={{
        ...hover.trigger,
        "aria-label": `citation ${citation.ordinal}`,
        "aria-haspopup": preview ? "dialog" : undefined,
        onKeyDown: event => { if (preview && event.key === "ArrowDown") { event.preventDefault(); hover.show(event.currentTarget, true); } },
      }} />
    </sup>
    {body}
  </>;
}

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
    // justify-defect: publication and rendering share the parser; every settled marker has its published row.
    if (!citation) throw new Error("published citation has no target");
    return <Citation citation={citation} adjacent={node?.properties["data-citation-adjacent"] === true} preview={citations.preview} />;
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
  "data-message-code": messageCode,
  "data-message-passage": passage,
  "data-message-source-start": sourceStart,
  "data-message-source-end": sourceEnd,
  ...rest
}: ComponentProps<"code"> & ExtraProps & {
  "data-message-code"?: boolean;
  "data-message-passage"?: boolean;
  "data-message-source-start"?: number;
  "data-message-source-end"?: number;
}) {
  const language = /language-(\w+)/.exec(className ?? "")?.[1];
  const block = messageCode ||
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
    <CodeBlock language={language ?? "text"} passage={passage ? { start: sourceStart!, end: sourceEnd! } : null}>
      <code className={className} {...rest}>
        {children}
      </code>
    </CodeBlock>
  );
}

function codeText(node: ReactNode): string {
  return Children.toArray(node).map(child => isValidElement<{ children?: ReactNode }>(child)
    ? codeText(child.props.children) : typeof child === "string" || typeof child === "number" ? String(child) : "").join("");
}

function CodeBlock({
  language,
  children,
  passage,
}: {
  language: string;
  children: ReactNode;
  passage: MarkdownPassage | null;
}) {
  const text = codeText(children);
  const copy = useCopyFeedback(text);
  const { say } = useOutcome();
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const content = useRef<HTMLDivElement>(null);
  if (defect) throw defect.error;
  const select = () => {
    if (!content.current) return;
    const range = document.createRange(); range.selectNodeContents(content.current);
    const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
    content.current.focus({ preventScroll: true });
  };
  const onCopy = () => copy.copy(text).catch((error: unknown) => {
    if (error instanceof ClipboardWriteUnavailableError)
      say({ fact: "couldn’t copy the code.", reason: "copying isn’t available here." }, [{ label: "select code", commandKey: "select code", run: select }]);
    else setDefect({ error });
  });
  return (
    <div className={styles.codeBlock} data-message-passage={passage ? "true" : undefined}
      data-message-source-start={passage?.start} data-message-source-end={passage?.end}>
      <div className={styles.codeHeader} data-pane-find-exclude="true">
        <span className={styles.codeLanguage}>{language}</span>
        <Button iconOnly icon={copy.copied ? <Icon.Check /> : <Icon.Copy />} aria-label="copy code"
          className={styles.copy} onClick={() => void onCopy()} />
        {copy.occurrence ? <Announcement text="copied" level="Polite" occurrence={copy.occurrence} /> : null}
      </div>
      <div
        ref={content}
        tabIndex={-1}
        className={styles.codeContent}
        data-pane-find-code-scroll="true"
        data-lang={language}
      >
        <pre className={styles.codePre}>{children}</pre>
      </div>
    </div>
  );
}

const components: Components = {
  h1: ({ node: _node, ...props }) => <h3 {...props} />,
  h2: ({ node: _node, ...props }) => <h4 {...props} />,
  h3: ({ node: _node, ...props }) => <h5 {...props} />,
  h4: ({ node: _node, ...props }) => <h6 {...props} />,
  h5: ({ node: _node, ...props }) => <h6 {...props} />,
  h6: ({ node: _node, ...props }) => <h6 {...props} />,
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

function rehypeCitationAdjacency(citations: ReadonlyMap<string, Schema<"ChatCitationOut">>) {
  return (tree: Root) => {
    const visit = (node: Root | Element) => {
      let previous = false;
      for (const child of node.children) {
        const ordinal = child.type === "element" ? child.properties["data-nexus-citation"] : null;
        const citation = typeof ordinal === "string" && citations.has(ordinal);
        if (child.type === "element") {
          if (citation && previous) child.properties["data-citation-adjacent"] = true;
          visit(child);
        }
        previous = citation;
      }
    };
    visit(tree);
  };
}

function rehypeCaret({ live }: { live: boolean }) {
  return (tree: Root) => {
    const caret: Element = { type: "element", tagName: "span", properties: {
      className: [styles.caret], "aria-hidden": "true", "data-pane-find-exclude": "true",
    }, children: [] };
    const visitEnd = (node: Root | Element, code: boolean): boolean => {
      for (let index = node.children.length - 1; index >= 0; index--) {
        const child = node.children[index];
        if (child.type === "element" && child.tagName === "img") {
          if (live) node.children.splice(index + 1, 0, caret);
          return true;
        }
        if (child.type === "element" && child.tagName === "hr") {
          child.properties["data-message-terminal-rule"] = true;
          if (live) {
            caret.properties.className = [styles.caret, styles.caretBlock];
            node.children.splice(index + 1, 0, caret);
          }
          return true;
        }
        if (child.type === "element" && visitEnd(child, code || child.tagName === "pre")) return true;
        // ReactMarkdown escapes raw nodes to text after rehype; they are reading text here too.
        if (child.type !== "text" && child.type !== "raw") continue;
        if (!child.value || !code && !child.value.trim()) continue;
        if (!live) return true;
        // Markdown adds one terminal code newline; the caret belongs to its last content line.
        if (code && child.value.endsWith("\n")) {
          child.value = child.value.slice(0, -1);
          node.children.splice(index + 1, 0, caret, { type: "text", value: "\n" });
        } else node.children.splice(index + 1, 0, caret);
        return true;
      }
      if (node.type === "element" && (code && node.tagName === "code" || ["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th", "blockquote"].includes(node.tagName))) {
        if (live) {
          caret.properties.className = [styles.caret, styles.caretBlock];
          node.children.push(caret);
        }
        return true;
      }
      return false;
    };
    if (!visitEnd(tree, false) && live) tree.children.push({ type: "element", tagName: "p", properties: {}, children: [caret] });
  };
}

/**
 * Assistant markdown: gfm, highlighted code with a language label and copy,
 * tables that scroll, settled citation numerals and a trailing live caret.
 * Source passage mapping shares the parser; saved previews stay literal.
 */
export const MarkdownMessage = memo(function MarkdownMessage({
  content,
  citations,
  live,
  citationPreview,
  passage,
}: {
  content: string;
  citations: Schema<"ChatCitationOut">[];
  live: boolean;
  citationPreview: boolean;
  passage: MarkdownPassage | null;
}) {
  const active = usePaneIsActive();
  const fine = useSyncExternalStore(subscribePreviewInput, () => matchMedia("(hover: hover) and (pointer: fine)").matches, () => false);
  const byIndex = useMemo(() => new Map(citations.map(citation => [String(citation.ordinal), citation])), [citations]);
  const cited = useMemo(
    () =>
      !live && citations.length
        ? {
            byIndex,
            preview: citationPreview && active && fine,
          }
        : null,
    [live, citations.length, byIndex, citationPreview, active, fine],
  );
  return (
    <div className={styles.prose}>
      <CitationContext value={cited}>
        <ReactMarkdown
          remarkPlugins={cited ? [remarkGfm, remarkCitations, [remarkMessagePassages, passage]] : [remarkGfm, [remarkMessagePassages, passage]]}
          rehypePlugins={[rehypeHighlight, rehypeMessagePassages, [rehypeCitationAdjacency, byIndex], [rehypeCaret, { live }]]}
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
