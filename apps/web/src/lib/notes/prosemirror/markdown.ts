import type { Node as ProseMirrorNode } from "prosemirror-model";
import { outlineSchema } from "@/lib/notes/prosemirror/schema";

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}\[\]()#+\-.!|>])/g, "\\$1");
}

function markText(text: string, markType: string, attrs: Record<string, unknown>): string {
  if (markType === "code") return `\`${text.replace(/`/g, "\\`")}\``;
  if (markType === "strong") return `**${text}**`;
  if (markType === "em") return `_${text}_`;
  if (markType === "strikethrough") return `~~${text}~~`;
  if (markType === "link") {
    const href = typeof attrs.href === "string" ? attrs.href : "";
    return href ? `[${text}](${href})` : text;
  }
  return text;
}

function inlineToMarkdown(node: ProseMirrorNode): string {
  if (node.type === outlineSchema.nodes.text) {
    let text = escapeMarkdown(node.text ?? "");
    for (const mark of node.marks) {
      text = markText(text, mark.type.name, mark.attrs);
    }
    return text;
  }
  if (node.type === outlineSchema.nodes.hard_break) {
    return "  \n";
  }
  if (node.type === outlineSchema.nodes.image) {
    const src = String(node.attrs.src ?? "");
    const alt = escapeMarkdown(String(node.attrs.alt ?? ""));
    return src ? `![${alt}](${src})` : alt;
  }
  if (node.type === outlineSchema.nodes.object_ref) {
    const objectType = String(node.attrs.objectType ?? "");
    const objectId = String(node.attrs.objectId ?? "");
    const label = String(node.attrs.label ?? "").trim();
    return label ? `[[${objectType}:${objectId}|${label}]]` : `[[${objectType}:${objectId}]]`;
  }
  return escapeMarkdown(node.textContent);
}

function paragraphToMarkdown(node: ProseMirrorNode): string {
  const parts: string[] = [];
  node.forEach((child) => {
    parts.push(inlineToMarkdown(child));
  });
  return parts.join("");
}

function blockToMarkdown(node: ProseMirrorNode, depth: number): string[] {
  const paragraph = node.child(0);
  const indent = "  ".repeat(depth);
  const id = String(node.attrs.id);
  const text = paragraphToMarkdown(paragraph).trim();
  const line = `${indent}- ${text} ^${id}`;
  const childLines: string[] = [];
  for (let index = 1; index < node.childCount; index += 1) {
    childLines.push(...blockToMarkdown(node.child(index), depth + 1));
  }
  return [line, ...childLines];
}

export function outlineDocToMarkdown(doc: ProseMirrorNode): string {
  const lines: string[] = [];
  doc.forEach((node) => {
    if (node.type === outlineSchema.nodes.outline_block) {
      lines.push(...blockToMarkdown(node, 0));
    }
  });
  return lines.join("\n");
}
