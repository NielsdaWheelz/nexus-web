// The Nexus input grammar: raw text becomes one typed intent plus the owned-search query.
import { FilePlus2, FileText, Globe, Library, MessageSquarePlus, Upload } from "lucide-react";
import { normalizeWorkspaceHref } from "@/lib/workspace/workspaceHref";
import { extractUrls } from "@/lib/extractUrls";
import { browseHref } from "@/lib/browse/query";
import { DESTINATIONS, getDestination, type DestinationId } from "@/lib/navigation/destinations";
import { parseResourceRef } from "@/lib/resourceGraph/resourceRef";
import { parseSearchInput } from "@/lib/search/parseSearchInput";
import { applyParsedInput, emptySearchQuery, type SearchQuery } from "@/lib/search/query";
import { searchHref } from "@/lib/search/searchParams";
import { MAX_ADD_ITEMS, parseAddUrlList } from "./addInput";
import type { NexusAction, NexusCommandId, NexusIcon } from "./model";

export type BrowseKind = "WebArticle" | "Podcast" | "Video" | "Epub";

export const NEXUS_COMMANDS: Record<
  NexusCommandId,
  {
    readonly label: string;
    readonly aliases: readonly [string, ...string[]];
    readonly argumentLabel: string;
    readonly keywords: readonly string[];
    readonly icon: NexusIcon;
    action(argument: string): NexusAction;
  }
> = {
  "Nexus.Quick.Note": {
    label: "quick note", aliases: ["/n"], argumentLabel: "text", icon: FileText,
    keywords: ["note", "new note", "create note", "jot", "capture"],
    action: (argument) => ({ kind: "Available", target: { kind: "OpenDailyPage", date: { kind: "Today" }, entry: { kind: "AppendNote", initialText: argument } } }),
  },
  "Nexus.Quick.Page": {
    label: "new page", aliases: ["/p"], argumentLabel: "title", icon: FilePlus2,
    keywords: ["page", "new page", "create page", "document"],
    action: (argument) => ({ kind: "Available", target: { kind: "CreatePage", titleDraft: argument } }),
  },
  "Nexus.Quick.Chat": {
    label: "new chat", aliases: ["/c", "/a"], argumentLabel: "message", icon: MessageSquarePlus,
    keywords: ["chat", "new chat", "start chat", "conversation"],
    action: (argument) => ({ kind: "Available", target: {
      kind: "InternalHref", href: "/conversations/new", labelHint: "new chat",
      ...(argument ? { entry: { kind: "ComposeChat", text: argument } as const } : {}),
    } }),
  },
  "Nexus.Quick.Library": {
    label: "new library", aliases: ["/l"], argumentLabel: "name", icon: Library,
    keywords: ["library", "new library", "create library", "collection"],
    action: (argument) => ({ kind: "Available", target: { kind: "CreateLibrary", nameDraft: argument } }),
  },
  "Nexus.Quick.Import": {
    label: "import", aliases: ["/i"], argumentLabel: "links", icon: Upload,
    keywords: ["add", "import", "url", "file"],
    action: (argument) => parseAddUrlList(argument).cells.length > MAX_ADD_ITEMS
      ? { kind: "Unavailable", reason: `add up to ${MAX_ADD_ITEMS} items at a time` }
      : { kind: "Available", target: {
        kind: "OpenAdd",
        seed: { kind: "Content", initialDestinations: [], ...(argument ? { initialUrlDraft: argument } : {}) },
      } },
  },
  "Nexus.Quick.Browse": {
    label: "browse…", aliases: ["/b"], argumentLabel: "query", icon: Globe,
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
  | { readonly kind: "ImportUrl"; readonly url: string };

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
  chat: "Nexus.Quick.Chat",
  library: "Nexus.Quick.Library",
};
const BROWSE_NOUNS: Record<string, BrowseKind> = {
  article: "WebArticle",
  podcast: "Podcast",
  video: "Video",
  book: "Epub",
};

function singleUrl(value: string): string | null {
  const urls = extractUrls(value);
  return urls.length === 1 && urls[0] === value ? new URL(value).toString() : null;
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
  const url = singleUrl(text);
  if (url !== null) return { kind: "ImportUrl", url };
  const afterOne = text.replace(/^\S+/, "").trim();
  const afterTwo = text.replace(/^\S+\s+\S+/, "").trim();
  const create = /^(?:new|create)\s+(note|page|chat|library)(?:\s+.*)?$/.exec(norm);
  if (create) return { kind: "Command", id: CREATE_NOUNS[create[1]!]!, argument: afterTwo };
  if (/^ask\s+\S/.test(norm)) return { kind: "Command", id: "Nexus.Quick.Chat", argument: afterOne };
  const browse = /^(?:browse|find)\s+(article|podcast|video|book)(?:\s+.*)?$/.exec(norm);
  if (browse) return { kind: "Browse", browseKind: BROWSE_NOUNS[browse[1]!]!, query: afterTwo };
  if (/^(add|import)(?:\s+.*)?$/.test(norm)) {
    const addUrl = afterOne ? singleUrl(afterOne) : "";
    if (addUrl !== null) return { kind: "Command", id: "Nexus.Quick.Import", argument: addUrl };
  }
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

/** Prepare the parsed intent without choosing a discovered result. */
export function nexusQueryAction(query: NexusQuery): NexusAction | null {
  if (!query.text) return null;
  const { intent } = query;
  switch (intent.kind) {
    case "Search":
      return nexusSearchAction(query.searchQuery);
    case "Command":
      return NEXUS_COMMANDS[intent.id].action(intent.argument);
    case "CommandLookup":
      return null;
    case "Browse":
      return nexusBrowseAction(intent.query, intent.browseKind);
    case "ChooseCreate":
      return { kind: "Available", target: { kind: "ChooseCreate", initialDraft: "" } };
    case "Destination": {
      const place = getDestination(intent.id);
      return { kind: "Available", target: place.id === "today"
        ? { kind: "OpenDailyPage", date: { kind: "Today" }, entry: { kind: "View" } }
        : { kind: "InternalHref", href: place.href, labelHint: place.label } };
    }
    case "Resource":
      return null; // The controller waits for the canonical item's exact activation.
    case "ImportUrl":
      return NEXUS_COMMANDS["Nexus.Quick.Import"].action(intent.url);
  }
}
