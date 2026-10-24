// Rendering and narration share authored note text and named-resource fields.
import type { Row } from "@/lib/notes/outline";
import { readText } from "@/lib/notes/texts";

export const outlineFilterFields = (row: Row): string[] => {
  const node = row.link.target;
  if (node.content.kind === "note") {
    const value = readText(node.item.ref)?.value;
    return [typeof value === "object" ? value.body_text : node.content.body_text];
  }
  return [
    node.item.label.trim() || node.item.ref.split(":")[0]!.replaceAll("_", " "),
    node.item.preview.source?.title ?? "",
  ];
};
