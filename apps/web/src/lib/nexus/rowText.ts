import { excerptTextParts } from "@nexus/authored/excerpt";
import type { Schema } from "@/lib/api/wire";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import type { NexusRow } from "./model";

/** The row's title: a highlight's literal in quotes, a passage's work, a note's first line, else its name. */
export function rowPrimaryText(row: NexusRow): string {
  const literal = (excerpt: Schema<"ExcerptOut">) => `${excerpt.truncated_before ? "…" : ""}${excerpt.text}${excerpt.truncated_after ? "…" : ""}`;
  const item = row.item;
  if (!item) return row.label;
  const body = item.preview.body;
  switch (body.kind) {
    case "named": return body.title || "untitled";
    case "prose": return parseResourceRef(item.ref)?.scheme === "note_block" || !body.excerpt.text ? row.label : literal(body.excerpt);
    case "passage":
      if (parseResourceRef(item.ref)?.scheme !== "highlight") return item.preview.source?.title?.trim() || "source";
      return `“${body.excerpt.kind === "content" ? literal({ text: excerptTextParts(body.excerpt.body).exact || "selected region",
        truncated_before: body.excerpt.selected_truncated_before, truncated_after: body.excerpt.selected_truncated_after }) : "table excerpt"}”`;
    case "images": return [body.count === 1 ? "image" : `${body.count} images`, ...body.alts.flatMap(alt => alt ? [literal(alt)] : [])].join("\n");
    case "reference": return body.label?.text ? `reference · ${literal(body.label)}` : "embedded resource";
    case "media": return body.media_summary.title;
  }
}
