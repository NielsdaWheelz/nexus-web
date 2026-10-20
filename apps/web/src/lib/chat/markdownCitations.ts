/**
 * Citation syntax shares the renderer's exact remark grammar with publication.
 * Only literal source runs can produce markers. Native GFM transforms may split
 * text into autolinks; project those partitions without decoding or reparsing.
 */
import type { Data } from "mdast";
import type { Extension } from "mdast-util-from-markdown";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified, type Processor } from "unified";

/** Half-open UTF-16 offsets into the original markdown, never decoded text. */
export type CitationMarker = Readonly<{
  ordinal_text: string;
  start: number;
  end: number;
}>;

type LiteralRun = {
  source_start: number;
  source_end: number;
  value_start: number;
  value_end: number;
};

declare module "mdast" {
  interface Data {
    nexusCitationMarker?: CitationMarker;
    nexusCitationLiteral?: { initial_start: number; runs: LiteralRun[] };
  }
}

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
  data?: Data;
  position?: { start: { offset?: number } };
};

type OriginalChild = {
  node: MarkdownNode;
  text: { value: string; runs: LiteralRun[] } | null;
};

/** Owned generated links carry their ordinal independently of their href. */
export function remarkCitations(this: Processor) {
  const originals = new WeakMap<MarkdownNode, OriginalChild[]>();
  const capture = (node: MarkdownNode): void => {
    if (!node.children || /^(link|linkReference|image|imageReference)$/.test(node.type)) return;
    originals.set(node, node.children.map((child) => {
      capture(child);
      if (child.type !== "text") return { node: child, text: null };
      if (child.value === undefined) throw new Error("Citation adapter: text has no value");
      const literal = child.data?.nexusCitationLiteral;
      // GFM task-list parsing removes its first whitespace character and moves
      // the native start position. Follow that edit; do not parse list prefixes.
      const current_start = child.position?.start.offset;
      if (literal && current_start === undefined) throw new Error("Citation adapter: text lost its position");
      const removed = literal && current_start !== undefined ? current_start - literal.initial_start : 0;
      if (removed < 0) throw new Error("Citation adapter: text start moved backwards");
      const runs = (literal?.runs ?? []).filter((run) => run.value_end > removed).map((run) => ({
        source_start: run.source_start + Math.max(0, removed - run.value_start),
        source_end: run.source_end,
        value_start: Math.max(0, run.value_start - removed),
        value_end: run.value_end - removed,
      }));
      return { node: child, text: { value: child.value, runs } };
    }));
  };
  const extension: Extension = {
    transforms: [capture],
    exit: {
      data(token) {
        const node = this.stack.pop();
        if (node?.type !== "text" || node.position?.start.offset === undefined) {
          throw new Error("Citation adapter: data has no positioned text");
        }
        const value_start = node.value.length;
        node.value += this.sliceSerialize(token);
        node.position.end = { line: token.end.line, column: token.end.column, offset: token.end.offset };
        if (token.type !== "data") return;
        node.data ??= {};
        const literal = node.data.nexusCitationLiteral ??= { initial_start: node.position.start.offset, runs: [] };
        const previous = literal.runs.at(-1);
        if (previous?.source_end === token.start.offset && previous.value_end === value_start) {
          previous.source_end = token.end.offset;
          previous.value_end = node.value.length;
        } else {
          literal.runs.push({ source_start: token.start.offset, source_end: token.end.offset, value_start, value_end: node.value.length });
        }
      },
    },
  };
  const data = this.data();
  // Capture before GFM's native autolink transform replaces text-node metadata.
  (data.fromMarkdownExtensions ??= []).unshift(extension);

  return (tree: MarkdownNode, file: { toString(): string }) => {
    const markdown = file.toString();
    const split = (value: string, offset: number, runs: LiteralRun[]): MarkdownNode[] => {
      const nodes: MarkdownNode[] = [];
      let cursor = 0;
      for (const run of runs) {
        const start = Math.max(run.value_start, offset);
        const end = Math.min(run.value_end, offset + value.length);
        if (start >= end) continue;
        const source_start = run.source_start + start - run.value_start;
        const source = markdown.slice(source_start, source_start + end - start);
        for (const match of source.matchAll(/\[([1-9][0-9]*)\]/g)) {
          const index = start - offset + match.index;
          if (cursor < index) nodes.push({ type: "text", value: value.slice(cursor, index) });
          const marker = { ordinal_text: match[1], start: source_start + match.index, end: source_start + match.index + match[0].length };
          nodes.push({
            type: "link",
            url: `#nexus-reader-citation-${marker.ordinal_text}`,
            data: { nexusCitationMarker: marker, hProperties: { "data-nexus-citation": marker.ordinal_text } },
            children: [{ type: "text", value: match[0] }],
          });
          cursor = index + match[0].length;
        }
      }
      if (cursor < value.length) nodes.push({ type: "text", value: value.slice(cursor) });
      return nodes;
    };
    const walk = (node: MarkdownNode): void => {
      if (!node.children || /^(link|linkReference|image|imageReference)$/.test(node.type)) return;
      const original = originals.get(node);
      if (!original) throw new Error("Citation adapter: parent lost its source children");
      const children: MarkdownNode[] = [];
      let index = 0;
      for (const child of original) {
        if (child.text === null) {
          if (node.children[index++] !== child.node) throw new Error("Citation adapter: native child identity changed");
          walk(child.node);
          children.push(child.node);
          continue;
        }
        for (const run of child.text.runs) {
          if (markdown.slice(run.source_start, run.source_end).replace(/\0/g, "�") !== child.text.value.slice(run.value_start, run.value_end)) {
            throw new Error("Citation adapter: literal source differs from text");
          }
        }
        let offset = 0;
        do {
          const piece = node.children[index++];
          const value = piece?.type === "text" ? piece.value
            : piece?.type === "link" && piece.children?.every((part) => part.type === "text")
              ? piece.children.map((part) => part.value).join("") : undefined;
          if (value === undefined || child.text.value.slice(offset, offset + value.length) !== value) {
            throw new Error("Citation adapter: native text partition changed its value");
          }
          if (piece.type === "text") children.push(...split(value, offset, child.text.runs));
          else children.push(piece);
          offset += value.length;
        } while (offset < child.text.value.length);
      }
      if (index !== node.children.length) throw new Error("Citation adapter: native text partition has extra children");
      node.children = children;
    };
    walk(tree);
  };
}

/** The executable and renderer use the same parser, extensions and transform. */
export function parseCitationMarkers(markdown: string): CitationMarker[] {
  const parser = unified().use(remarkParse).use(remarkGfm).use(remarkCitations);
  const tree = parser.runSync(parser.parse(markdown), { value: markdown });
  const markers: CitationMarker[] = [];
  const collect = (node: MarkdownNode): void => {
    if (node.data?.nexusCitationMarker) markers.push(node.data.nexusCitationMarker);
    node.children?.forEach(collect);
  };
  collect(tree);
  return markers.sort((a, b) => a.start - b.start);
}
