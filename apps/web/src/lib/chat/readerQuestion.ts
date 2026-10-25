// reader questions use the note grammar, never its lossy text projection. unsupported
// atoms refuse the whole conversion. markdown owns escaping and delimiter choice;
// multiline inline code becomes a block, and underline retains its text only.
import type { Delete, Emphasis, Link, Paragraph, PhrasingContent, RootContent, Strong } from "mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { defaultHandlers, toMarkdown } from "mdast-util-to-markdown";
import type { Mark } from "prosemirror-model";
import { noteBodySchema, type NoteBody } from "@nexus/authored/body";

export type ReaderQuestion =
  | { kind: "Blank" }
  | { kind: "Text"; content: string }
  | { kind: "Unsupported"; reason: "Images" | "Embeds" };

// Markdown attention delimiters cannot enclose edge whitespace. Lift only the
// edges of complete mark ranges; internal whitespace, code and link scopes stay.
function markdownMarkEdges(children: PhrasingContent[]): PhrasingContent[] {
  return children.flatMap((node): PhrasingContent[] => {
    if (node.type !== "strong" && node.type !== "emphasis" && node.type !== "delete" && node.type !== "link") return [node];
    node.children = markdownMarkEdges(node.children);
    if (node.type === "link") return [node];
    const before: PhrasingContent[] = [], after: PhrasingContent[] = [];
    while (node.children.length) {
      const first = node.children[0]!;
      if (first.type === "break") {
        before.push(first);
        node.children.shift();
      } else if (first.type === "text" && /^\s/u.test(first.value)) {
        const whitespace = /^\s+/u.exec(first.value)![0];
        before.push({ type: "text", value: whitespace });
        first.value = first.value.slice(whitespace.length);
        if (!first.value) node.children.shift();
      } else break;
    }
    while (node.children.length) {
      const last = node.children.at(-1)!;
      if (last.type === "break") {
        after.unshift(last);
        node.children.pop();
      } else if (last.type === "text" && /\s$/u.test(last.value)) {
        const whitespace = /\s+$/u.exec(last.value)![0];
        after.unshift({ type: "text", value: whitespace });
        last.value = last.value.slice(0, -whitespace.length);
        if (!last.value) node.children.pop();
      } else break;
    }
    return [...before, ...(node.children.length ? [node] : []), ...after];
  });
}

/** Preserve the complete question as markdown source; this does not save the note. */
export function convertReaderQuestion(body: NoteBody): ReaderQuestion {
  const block = noteBodySchema.nodeFromJSON(body.body_pm_json);
  let unsupported: "Images" | "Embeds" | null = false ? "Embeds" : null;
  block.descendants((node) => {
    if (node.type.name === "image") unsupported ??= "Images";
    if (node.type.name === "resource_embed") unsupported ??= "Embeds";
  });
  if (unsupported) return { kind: "Unsupported", reason: unsupported };

  const blocks: RootContent[] = [];
  let substantive = false;
  switch (block.attrs.presentation) {
    case "code":
      const codeText = block.textBetween(0, block.content.size, "", "\n");
      substantive = codeText.length > 0;
      blocks.push({ type: "code", value: codeText });
      break;
    case "prose": {
      let paragraph: Paragraph = { type: "paragraph", children: [] };
      // shared marks stay open across adjacent nodes; reopening them can change meaning.
      const active: { mark: Mark; node: Strong | Emphasis | Delete | Link }[] = [];
      const flush = () => {
        if (paragraph.children.length) {
          paragraph.children = markdownMarkEdges(paragraph.children);
          blocks.push(paragraph);
        }
        paragraph = { type: "paragraph", children: [] };
        active.length = 0;
      };
      const append = (nodeMarks: readonly Mark[], content: PhrasingContent[]) => {
        const marks = nodeMarks.filter((mark) => mark.type.name !== "code" && mark.type.name !== "underline");
        let shared = 0;
        while (shared < active.length && shared < marks.length && active[shared]!.mark.eq(marks[shared]!)) shared++;
        active.length = shared;
        let children = active.at(-1)?.node.children ?? paragraph.children;
        for (const mark of marks.slice(shared)) {
          let wrapper: Strong | Emphasis | Delete | Link;
          switch (mark.type.name) {
            case "strong": wrapper = { type: "strong", children: [] }; break;
            case "em": wrapper = { type: "emphasis", children: [] }; break;
            case "strikethrough": wrapper = { type: "delete", children: [] }; break;
            case "link": wrapper = { type: "link", url: mark.attrs.href, title: mark.attrs.title, children: [] }; break;
            default:
              // justify-defect: all six note marks are handled, including the two omitted above.
              throw new Error(`Unexpected reader question mark: ${mark.type.name}`);
          }
          children.push(wrapper);
          active.push({ mark, node: wrapper });
          children = wrapper.children;
        }
        const previous = children.at(-1), next = content[0];
        if (content.length === 1 && next?.type === "inlineCode" && previous?.type === "inlineCode") previous.value += next.value;
        else children.push(...content);
      };
      for (let index = 0; index < block.childCount;) {
        const node = block.child(index++);
        if (node.marks.some((mark) => mark.type.name === "code")) {
          const run = [node];
          while (index < block.childCount && block.child(index).marks.some((mark) => mark.type.name === "code")) run.push(block.child(index++));
          const value = run.map((part) => {
            if (part.type.name === "text") return part.text!;
            if (part.type.name === "hard_break") return "\n";
            // justify-defect: images were refused before reaching the paragraph grammar.
            throw new Error(`Unexpected reader question code: ${part.type.name}`);
          }).join("");
          substantive = true;
          if (/[\r\n]/u.test(value)) {
            flush();
            blocks.push({ type: "code", value });
            // Fenced code cannot carry inline marks. Keep each distinct link's
            // destination and title explicitly beside the unchanged code.
            const links = new Map<string, Mark>();
            for (const part of run) for (const mark of part.marks) if (mark.type.name === "link") {
              links.set(JSON.stringify([mark.attrs.href, mark.attrs.title]), mark);
            }
            for (const link of links.values()) blocks.push({ type: "paragraph", children: [{
              type: "link", url: link.attrs.href, title: link.attrs.title,
              children: [{ type: "text", value: link.attrs.href }],
            }] });
          } else {
            for (const part of run) append(part.marks, [{ type: "inlineCode", value: part.text! }]);
          }
          continue;
        }
        switch (node.type.name) {
          case "text": {
            const value = node.text!;
            substantive ||= node.marks.some((mark) => mark.type.name === "link") || !!value.trim();
            append(node.marks, value.split(/\r\n|\r|\n/u).flatMap((part, index): PhrasingContent[] => [
              ...(index ? [{ type: "break" } as const] : []),
              ...(part ? [{ type: "text", value: part } as const] : []),
            ]));
            break;
          }
          case "hard_break":
            append(node.marks, [{ type: "break" }]);
            break;
          default:
            // justify-defect: the note grammar permits only text, hard breaks and refused images here.
            throw new Error(`Unexpected reader question inline: ${node.type.name}`);
        }
      }
      flush();
      break;
    }
    default:
      // justify-defect: one trusted note body is a paragraph, code block or refused embed.
      throw new Error(`Unexpected reader question block: ${block.type.name}`);
  }
  if (!substantive) return { kind: "Blank" };
  // CommonMark has no terminal paragraph hard break. Keep those authored line
  // endings literally in the source instead of emitting a visible backslash.
  let terminalNewlines = "";
  const last = blocks.at(-1);
  if (last?.type === "paragraph") {
    while (last.children.at(-1)?.type === "break") {
      last.children.pop();
      terminalNewlines += "\n";
    }
    if (!last.children.length) blocks.pop();
  }
  // the serializer appends one document terminator; authored whitespace stays intact.
  const content = toMarkdown({ type: "root", children: blocks }, {
    extensions: [gfmToMarkdown()], fences: true,
    handlers: { code(node, parent, state, info) {
      const fenced = defaultHandlers.code(node, parent, state, info);
      if (!node.value.endsWith("\n")) return fenced;
      // The default handler adds a closing LF even when the payload has one.
      const closing = fenced.lastIndexOf("\n");
      return fenced.slice(0, closing) + fenced.slice(closing + 1);
    } },
  }).slice(0, -1) + terminalNewlines;
  return { kind: "Text", content };
}
