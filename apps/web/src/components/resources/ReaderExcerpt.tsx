"use client";

import { useReaderProfile } from "@/lib/reader/ReaderProfileContext";
import { readerSurfaceStyle } from "@/lib/reader/typography";
import { assertNever } from "@/lib/assertNever";
import { createElement, Fragment, type ReactNode } from "react";
import { excerptPointOffsets, type ExcerptNode, type ExcerptView } from "@nexus/authored/excerpt";
import readerStyles from "@/components/HtmlRenderer.module.css";
import styles from "./ReaderExcerpt.module.css";

/** Passive evidence only: no source targets, assets, publisher styles or landmarks. */
export default function ReaderExcerpt({ excerpt, color, full = false }: { excerpt: ExcerptView; color: string | null; full?: boolean }) {
  const profile = useReaderProfile();
  if (excerpt.kind === "table_summary") return <span className={styles.notice}>table excerpt</span>;
  const { body } = excerpt;
  const at = excerptPointOffsets(body.content);
  const start = at(body.selection.start);
  const end = at(body.selection.end);
  let position = 0;
  function render(node: ExcerptNode, key: number): ReactNode {
    if (node.kind === "text") {
      const text = Array.from(node.text), base = position;
      position += text.length;
      const from = Math.max(0, Math.min(text.length, start - base));
      const to = Math.max(from, Math.min(text.length, end - base));
      return <Fragment key={key}>{text.slice(0, from).join("")}{to > from ? <mark className={styles.selected} data-color={color ?? undefined}>{text.slice(from, to).join("")}</mark> : null}{text.slice(to).join("")}</Fragment>;
    }
    if (!("children" in node)) {
      position++;
      switch (node.kind) {
        case "br": case "hr": return createElement(node.kind, { key });
        case "media_gap": return createElement("span", { key, className: styles.notice, "data-flow": node.flow, "data-excerpt-interface": true }, node.media_kind === "image" ? "image omitted" : "media omitted");
        default: return assertNever(node);
      }
    }
    const children: ReactNode[] = [];
    for (let index = 0; index < node.children.length; index++) {
      const child = node.children[index]!;
      if (node.kind !== "table" || child.kind !== "tr") { children.push(render(child, index)); continue; }
      const rows: ReactNode[] = [], first = index;
      while (index < node.children.length && node.children[index]!.kind === "tr") { rows.push(render(node.children[index]!, index)); index++; }
      children.push(<tbody key={first}>{rows}</tbody>); index--;
    }
    const tag = node.kind === "a" || node.kind === "xref" ? "span" : ["section", "article", "header", "footer", "nav", "aside", "main"].includes(node.kind) ? "div" : node.kind;
    const attributes = { key, lang: node.lang ?? undefined, dir: node.dir ?? undefined,
      ...(node.kind === "ol" ? { start: node.start, reversed: node.reversed } : {}),
      ...(node.kind === "li" ? { value: node.value ?? undefined } : {}),
      ...(node.kind === "td" || node.kind === "th" ? { colSpan: node.col_span, rowSpan: node.row_span, scope: node.scope ?? undefined } : {}) };
    const rendered = createElement(tag, attributes, children);
    return node.kind === "table" ? <div key={key} className={styles.tableScroll}>{rendered}</div> : rendered;
  }
  return <div data-resource-primary className={`${readerStyles.renderer} ${styles.excerpt}`} data-structure={body.structure} style={readerSurfaceStyle(profile)} lang={body.lang ?? undefined} dir={body.dir ?? undefined}>
    {excerpt.omitted_before ? <span className={styles.notice} aria-label="earlier text omitted">…</span> : null}
    {body.content.map(render)}
    {body.structure !== "captured" && start === end ? <mark className={styles.selected} data-color={color ?? undefined}><span className={styles.notice} data-excerpt-interface>selected region</span></mark> : null}
    {excerpt.omitted_after ? <span className={styles.notice} aria-label="later text omitted">…</span> : null}
    {full && body.structure === "unknown" ? <div className={styles.notice}>original formatting wasn’t saved</div> : null}
  </div>;
}
