// The Nexus input grammar: raw text becomes one typed intent plus the owned-search query.
import type { ClipboardEvent } from "react";
import * as Icon from "@/lib/ui/icons";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";
import { extractLinks } from "@/lib/extractLinks";
import { browseHref } from "@/lib/browse/query";
import { DESTINATIONS, type DestinationId } from "@/lib/navigation/destinations";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { parseSearchInput } from "@/lib/search/parseSearchInput";
import { applyParsedInput, emptySearchQuery, type SearchQuery } from "@/lib/search/query";
import { searchHref } from "@/lib/search/searchParams";
import type { NexusAction, NexusCommandId } from "./model";

export type BrowseKind = "WebArticle" | "Podcast" | "Video" | "Epub";

export const NEXUS_COMMANDS: Record<
  NexusCommandId,
  {
    readonly label: string;
    readonly aliases: readonly [string, ...string[]];
    readonly argumentLabel: string;
    readonly keywords: readonly string[];
    readonly icon: Icon.Glyph;
    action(argument: string): NexusAction;
  }
> = {
  "Nexus.Quick.Note": {
    label: "quick note", aliases: ["/n"], argumentLabel: "text", icon: Icon.Today,
    keywords: ["note", "new note", "create note", "jot", "capture"],
    action: (argument) => ({ kind: "Available", target: { kind: "OpenDailyPage", date: { kind: "Today" }, entry: { kind: "AppendNote", initialText: argument } } }),
  },
  "Nexus.Quick.Page": {
    label: "new page", aliases: ["/p"], argumentLabel: "title", icon: Icon.Page,
    keywords: ["page", "new page", "create page", "document"],
    action: (argument) => ({ kind: "Available", target: {
      kind: "InternalHref", href: "/pages/new",
      ...(argument ? { entry: { kind: "ComposePage", title: argument } as const } : {}),
    } }),
  },
  "Nexus.Quick.Chat": {
    label: "ask librarian", aliases: ["/c", "/a"], argumentLabel: "message", icon: Icon.Chat,
    keywords: ["librarian", "ask", "messages"],
    action: (argument) => ({ kind: "Available", target: {
      kind: "InternalHref", href: "/librarian", labelHint: "librarian",
      ...(argument ? { entry: { kind: "ComposeChat", text: argument } as const } : {}),
    } }),
  },
  "Nexus.Quick.Library": {
    label: "new library", aliases: ["/l"], argumentLabel: "name", icon: Icon.Library,
    keywords: ["library", "new library", "create library", "collection"],
    action: (argument) => ({ kind: "Available", target: { kind: "CreateLibrary", nameDraft: argument } }),
  },
  "Nexus.Quick.Import": {
    label: "import", aliases: ["/i"], argumentLabel: "links", icon: Icon.Upload,
    keywords: ["add", "import", "url", "file"],
    action: (argument) => ({ kind: "Available", target: { kind: "OpenImport", text: argument } }),
  },
  "Nexus.Quick.Browse": {
    label: "browse…", aliases: ["/b"], argumentLabel: "query", icon: Icon.Browse,
    keywords: ["browse", "find"],
    action: (argument) => ({ kind: "Available", target: { kind: "ChooseBrowse", query: argument } }),
  },
};

export type NexusIntent =
  | { readonly kind: "Search" }
  | { readonly kind: "Command"; readonly id: NexusCommandId; readonly argument: string }
  | { readonly kind: "CommandLookup"; readonly head: string }
  | { readonly kind: "Browse"; readonly browseKind: BrowseKind; readonly query: string }
  | { readonly kind: "ChooseCreate" }
  | { readonly kind: "Destination"; readonly id: DestinationId }
  | { readonly kind: "Resource"; readonly ref: string }
  /** The whole input is links, ready for an explicit send. */
  | { readonly kind: "ImportLinks"; readonly links: readonly string[] };

export interface NexusQuery {
  /** The input trimmed; `norm` is it lowercased. */
  readonly text: string;
  readonly norm: string;
  readonly intent: NexusIntent;
  readonly searchQuery: SearchQuery;
}

const CREATE_NOUNS: Record<string, NexusCommandId> = {
  note: "Nexus.Quick.Note",
  page: "Nexus.Quick.Page",
  library: "Nexus.Quick.Library",
};
const BROWSE_NOUNS: Record<string, BrowseKind> = {
  article: "WebArticle",
  podcast: "Podcast",
  video: "Video",
  book: "Epub",
};

/** The links, when the text is links and nothing else. */
function wholeLinks(text: string): string[] | null {
  const { links, rest } = extractLinks(text, "Urls");
  return links.length > 0 && rest === "" ? links : null;
}

function parseIntent(text: string, norm: string): NexusIntent {
  if (text.startsWith("/")) {
    const head = text.split(/\s/, 1)[0]!;
    const id = (Object.keys(NEXUS_COMMANDS) as NexusCommandId[])
      .find((id) => NEXUS_COMMANDS[id].aliases.includes(head.toLowerCase()));
    return id
      ? { kind: "Command", id, argument: text.slice(head.length).trim() }
      : { kind: "CommandLookup", head };
  }
  if (parseResourceRef(text)) return { kind: "Resource", ref: text };
  if (norm === "new" || norm === "create") return { kind: "ChooseCreate" };
  const go = /^go(?:\s+to)?\s+(.+)$/.exec(norm);
  if (go) {
    const name = go[1]!.trim();
    const label = DESTINATIONS.find((place) => place.label.toLowerCase() === name);
    const aliases = DESTINATIONS.filter((place) => place.keywords.some((alias) => alias.toLowerCase() === name));
    const place = label ?? (aliases.length === 1 ? aliases[0] : null);
    if (place) return { kind: "Destination", id: place.id };
    return { kind: "Search" };
  }
  const links = wholeLinks(text);
  if (links !== null) return { kind: "ImportLinks", links };
  const afterOne = text.replace(/^\S+/, "").trim();
  const afterTwo = text.replace(/^\S+\s+\S+/, "").trim();
  const create = /^(?:new|create)\s+(note|page|library)(?:\s+.*)?$/.exec(norm);
  if (create) return { kind: "Command", id: CREATE_NOUNS[create[1]!]!, argument: afterTwo };
  if (/^ask\s+\S/.test(norm)) return { kind: "Command", id: "Nexus.Quick.Chat", argument: afterOne };
  const browse = /^(?:browse|find)\s+(article|podcast|video|book)(?:\s+.*)?$/.exec(norm);
  if (browse) return { kind: "Browse", browseKind: BROWSE_NOUNS[browse[1]!]!, query: afterTwo };
  if (/^(add|import)(?:\s+.*)?$/.test(norm) && (afterOne === "" || wholeLinks(afterOne) !== null))
    return { kind: "Command", id: "Nexus.Quick.Import", argument: afterOne };
  return { kind: "Search" };
}

export function parseNexusQuery(raw: string): NexusQuery {
  const text = raw.trim();
  const norm = text.toLowerCase();
  return {
    text,
    norm,
    intent: parseIntent(text, norm),
    searchQuery: applyParsedInput(emptySearchQuery(), parseSearchInput(text)),
  };
}

export function nexusBrowseAction(query: string, kind: BrowseKind): NexusAction {
  const href = normalizeWorkspaceHref(browseHref({ text: query, kind, source: null, sort: "Relevance" }));
  return href === null
    ? { kind: "Unavailable", reason: "this input is too long for a browse address" }
    : { kind: "Available", target: { kind: "InternalHref", href, labelHint: "browse" } };
}

export function nexusSearchAction(query: SearchQuery): NexusAction {
  const href = normalizeWorkspaceHref(searchHref(query));
  return href === null
    ? { kind: "Unavailable", reason: "this input is too long for a search address" }
    : { kind: "Available", target: { kind: "InternalHref", href, labelHint: "search" } };
}

/** A multi-line paste lands on one line, its breaks as spaces, since a single-line input
 * would drop them and glue links together. Returns the input's new value, or null when the
 * paste has no break and pastes natively. */
export function flattenedPaste(event: ClipboardEvent<HTMLInputElement>): string | null {
  const text = event.clipboardData.getData("text/plain");
  if (!/[\r\n]/.test(text)) return null;
  event.preventDefault();
  const input = event.currentTarget;
  input.setRangeText(text.trim().replace(/\s*[\r\n]+\s*/g, " "), input.selectionStart ?? input.value.length, input.selectionEnd ?? input.value.length, "end");
  return input.value;
}
