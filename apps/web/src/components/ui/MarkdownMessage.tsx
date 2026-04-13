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
  type ReactNode,
  type HTMLAttributes,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "./hljs-theme.css";
import styles from "./MarkdownMessage.module.css";

const remarkPlugins = [remarkGfm];
const rehypePlugins = [rehypeHighlight];

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

  const handleCopy = useCallback(() => {
    const el = document.querySelector(`[data-lang="${language}"]`);
    const text = el?.textContent ?? "";
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [language]);

  return (
    <div className={styles.codeBlock}>
      <div className={styles.codeBlockHeader}>
        <span>{language}</span>
        <button type="button" className={styles.copyBtn} onClick={handleCopy}>
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <div className={styles.codeBlockContent} data-lang={language}>
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

function MarkdownMessageInner({ content }: { content: string }) {
  return (
    <div className={styles.markdown}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
      >
        {content}
      </ReactMarkdown>
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
