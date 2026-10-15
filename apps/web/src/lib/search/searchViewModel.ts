// The one projection of a wire search result into the row the pane and Nexus
// show. Identities are the server's: services/search/project.py builds refs,
// context and activation together and refuses an unactivatable row, so this
// module derives display text only.

import type { ApiJson } from "@/lib/api/wire";
import {
  decodeOptionalPublicationDate,
  decodePublicationDateOnly,
  type PublicationDate,
} from "@/lib/dates/publicationDate";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { EmphasisSegment } from "@/lib/ui/emphasis";
import type { SearchResultRowViewModel } from "./types";

type Result = ApiJson<"/search", "get">["results"][number];
type TextResult = Exclude<Result, { media_summary: unknown }>;
type Described = {
  typeLabel: string;
  primaryText: string;
  sourceMeta: string | null;
};

/** `<b>`…`</b>` is the only markup a snippet carries. */
export function parseSnippetSegments(snippet: string): EmphasisSegment[] {
  const segments: EmphasisSegment[] = [];
  let emphasized = false;
  for (const part of snippet.split(/(<\/?b>)/i)) {
    const tag = part.toLowerCase();
    if (tag === "<b>" || tag === "</b>") emphasized = tag === "<b>";
    else if (part) segments.push({ text: part, emphasized });
  }
  return segments;
}

const titled = (title: string, kind: string | null) =>
  [title, kind?.replace(/_/g, " ")].filter(Boolean).join(" — ") || null;

/** Type label, title and source line; the arguments name the per-type rules. */
const describe = (
  typeLabel: string,
  primaryText: string,
  sourceMeta: string | null,
): Described => ({ typeLabel, primaryText, sourceMeta });

function described(result: TextResult, plain: string): Described {
  const label = result.source_label;
  switch (result.type) {
    case "contributor":
      return describe(
        "author",
        result.contributor.display_name || plain || "Author",
        null,
      );
    case "podcast":
      return describe("podcast", result.title || plain || "Untitled", label);
    case "page":
      return describe("page", result.title || plain || "Untitled page", label);
    case "note_block":
      return describe(
        "note",
        result.highlight_excerpt || result.body_text || plain || "Note",
        "note",
      );
    case "highlight":
      return describe(
        "highlight",
        result.exact || plain || "Highlight",
        label ?? "highlight",
      );
    case "fragment":
      return describe("fragment", plain || "Fragment", label ?? "fragment");
    case "message":
      return describe(
        "message",
        plain || `Message #${result.seq}`,
        label ?? `message #${result.seq}`,
      );
    case "conversation":
      return describe(
        "conversation",
        result.title || plain || "Conversation",
        label ?? "conversation",
      );
    case "artifact":
      return describe(
        "artifact",
        result.title || plain || "Dossier",
        label ?? "artifact",
      );
    case "evidence_span":
      return describe(
        result.citation_label,
        plain || result.citation_label,
        label ?? result.citation_label,
      );
    case "web_result":
      return describe(
        "web result",
        result.title || plain || result.url,
        result.source_name ?? result.display_url ?? label ?? "web",
      );
    case "content_chunk":
      return describe(
        result.citation_label,
        plain,
        label || titled(result.title, result.media_kind),
      );
    case "reader_apparatus_item":
      return describe(
        result.apparatus_kind.replace(/_/g, " "),
        plain,
        label || titled(result.source.title, result.source.media_kind),
      );
  }
}

function publicationDate(result: TextResult): PublicationDate | null {
  if (result.type === "web_result")
    return decodeOptionalPublicationDate(
      result.published_at,
      "search published_at",
    );
  if (!("source" in result) || result.source.original_published_date === null)
    return null;
  return decodePublicationDateOnly(
    result.source.original_published_date,
    "search source.original_published_date",
  );
}

/** The row for one result; none for a result that opens nowhere. */
export function projectSearchResult(
  result: Result,
): SearchResultRowViewModel[] {
  const href = result.activation.href;
  if (href === null) return [];
  const base = {
    key: `${result.type}-${result.id}`,
    score: result.score,
    resourceRef: result.resource_ref,
    ownerResourceRef: result.owner_resource_ref,
    activation: { ...result.activation, href },
    actionSubject: {
      ref: assumeCanonicalResourceRef(result.action_subject_ref),
    },
    snippetSegments: parseSnippetSegments(result.snippet),
  };
  if ("media_summary" in result)
    return [{ ...base, type: result.type, mediaSummary: result.media_summary }];
  return [
    {
      ...base,
      type: result.type,
      ...described(result, result.snippet.replace(/<\/?b>/gi, "")),
      publicationDate: publicationDate(result),
      contributorCredits:
        "source" in result
          ? result.source.contributors
          : result.type === "podcast"
            ? result.contributors
            : [],
    },
  ];
}
