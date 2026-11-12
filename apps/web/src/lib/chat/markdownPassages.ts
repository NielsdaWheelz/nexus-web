// A source range selects its smallest rendered passage. The renderer's own
// parser supplies spans and fenced-code origins; syntax highlighting keeps its
// text and nested spans when the selected content lines are framed afterward.
import type { Element, ElementContent, Root as HtmlRoot } from "hast";
import type { Nodes, Root } from "mdast";
import type { Extension } from "mdast-util-from-markdown";
import type { Processor } from "unified";

/** Half-open UTF-16 offsets into the original markdown. */
export interface MarkdownPassage { readonly start: number; readonly end: number }

declare module "mdast" {
  interface Data { nexusCodeContentLine?: number }
}

export function remarkMessagePassages(this: Processor, passage: MarkdownPassage | null) {
  const extension: Extension = { enter: {
    codeFencedFence(token) {
      if (this.data.flowCodeInside) return;
      const code = this.stack.at(-1);
      if (code?.type !== "code") throw new Error("Markdown passage: fence has no code owner");
      (code.data ??= {}).nexusCodeContentLine = token.start.line + 1;
    },
  } };
  (this.data().fromMarkdownExtensions ??= []).push(extension);
  return (tree: Root, file: { toString(): string }) => {
    const source = file.toString();
    let selected: { node: Nodes; start: number; end: number; tight: boolean } = { node: tree, start: 0, end: source.length, tight: false };
    const visit = (node: Nodes, parent: Nodes | null, tight: boolean) => {
      if (node.type === "list") tight = !node.spread && !node.children.some(item => item.spread);
      if (node.type === "code") ((node.data ??= {}).hProperties ??= {})["data-message-code"] = true;
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (passage && ["paragraph", "heading", "tableCell", "code"].includes(node.type) && start !== undefined && end !== undefined &&
          start <= passage.start && end >= passage.end && end - start <= selected.end - selected.start)
        selected = { node, start, end, tight: parent?.type === "listItem" && tight };
      if ("children" in node) node.children.forEach(child => visit(child, node, tight));
    };
    visit(tree, null, false);
    if (passage === null) return;
    const { node, start, end, tight } = selected;
    const data = node.data ??= {};
    const properties = data.hProperties ??= {};
    properties["data-message-source-start"] = start;
    properties["data-message-source-end"] = end;
    if (node.type === "code" && node.value) {
      const starts = [0];
      for (const match of source.matchAll(/\r\n|\r|\n/g)) starts.push(match.index + match[0].length);
      const origin = data.nexusCodeContentLine ?? node.position!.start.line;
      const count = node.value.split(/\r\n|\r|\n/).length;
      const lines = Array.from({ length: count }, (_, index) => ({
        start: Math.max(start, starts[origin + index - 1]),
        end: Math.min(end, starts[origin + index] ?? source.length),
      }));
      const first = lines.findIndex(line => line.start <= passage.start && passage.start < line.end);
      const last = lines.findIndex(line => line.start < passage.end && passage.end <= line.end);
      if (first !== -1 && last >= first) {
        properties["data-message-line-start"] = first;
        properties["data-message-line-end"] = last + 1;
        properties["data-message-source-start"] = lines[first].start;
        properties["data-message-source-end"] = lines[last].end;
        return;
      }
    }
    properties["data-message-passage"] = true;
    // Tight-list conversion strips <p>. A span preserves this passage and leaves
    // the list owner's bullet/checkbox and nested blocks in their normal flow.
    if (node.type === "paragraph" && tight) data.hName = "span";
    if (node.type === "root") data.hName = "div";
  };
}

type CodeLine = { children: ElementContent[]; ending: string };

/** Split syntax spans only at their existing line endings; no text is decoded. */
function syntaxLines(nodes: readonly ElementContent[]): CodeLine[] {
  const lines: CodeLine[] = [{ children: [], ending: "" }];
  for (const node of nodes) {
    if (node.type === "element") {
      for (const line of syntaxLines(node.children)) {
        if (line.children.length) lines.at(-1)!.children.push({ ...node, children: line.children });
        if (line.ending) { lines.at(-1)!.ending = line.ending; lines.push({ children: [], ending: "" }); }
      }
    } else if (node.type === "text") {
      const parts = node.value.split(/(\r\n|\r|\n)/);
      for (let i = 0; i < parts.length; i += 2) {
        if (parts[i]) lines.at(-1)!.children.push({ ...node, value: parts[i] });
        if (parts[i + 1]) { lines.at(-1)!.ending = parts[i + 1]; lines.push({ children: [], ending: "" }); }
      }
    } else lines.at(-1)!.children.push(node);
  }
  return lines;
}

/** Run after rehype-highlight, which replaces a code element's children. */
export function rehypeMessagePassages() {
  return (tree: HtmlRoot | Element) => {
    const visit = (node: HtmlRoot | Element) => {
      if (node.type === "element" && node.tagName === "code") {
        const first = node.properties["data-message-line-start"];
        const end = node.properties["data-message-line-end"];
        if (typeof first === "number" && typeof end === "number") {
          const lines = syntaxLines(node.children);
          if (first < 0 || end > lines.length || first >= end) throw new Error("Markdown passage: syntax highlighting lost source lines");
          const selected: Element = { type: "element", tagName: "span", properties: {
            "data-message-passage": true,
            "data-message-code-passage": true,
            "data-message-source-start": node.properties["data-message-source-start"],
            "data-message-source-end": node.properties["data-message-source-end"],
          }, children: [] };
          const children: ElementContent[] = [];
          for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            if (index === first) children.push(selected);
            const inside = index >= first && index < end;
            (inside ? selected.children : children).push(...line.children);
            if (line.ending) (inside && index < end - 1 ? selected.children : children).push({ type: "text", value: line.ending });
          }
          node.children = children;
          for (const key of ["data-message-line-start", "data-message-line-end", "data-message-source-start", "data-message-source-end"]) delete node.properties[key];
        }
      }
      for (const child of node.children) if (child.type === "element") visit(child);
    };
    visit(tree);
  };
}
