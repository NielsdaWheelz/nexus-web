// The Nexus input grammar: raw text becomes one typed intent plus the owned-search query.
import { FilePlus2, FileText, Library, MessageSquarePlus, Upload } from "lucide-react";
import { extractUrls } from "@/lib/extractUrls";
import { parseSearchInput } from "@/lib/search/parseSearchInput";
import { applyParsedInput, emptySearchQuery, type SearchQuery } from "@/lib/search/query";
import type { NexusCommandId, NexusIcon, NexusTarget } from "./model";

export type BrowseKind = "WebArticle" | "Podcast" | "Video" | "Epub";

export function chatHref(draft: string): string {
  return draft ? `/conversations/new?draft=${encodeURIComponent(draft)}` : "/conversations/new";
}

export const NEXUS_COMMANDS: Record<
  NexusCommandId,
  {
    readonly label: string;
    readonly alias: string;
    readonly keywords: readonly string[];
    readonly category: "Create" | "Acquire";
    readonly icon: NexusIcon;
    target(argument: string): NexusTarget;
  }
> = {
  "Nexus.Quick.Note": {
    label: "Quick Note", alias: "/n ", category: "Create", icon: FileText,
    keywords: ["note", "new note", "create note", "jot", "capture"],
    target: (argument) => ({ kind: "OpenDailyPage", date: { kind: "Today" }, entry: { kind: "AppendNote", initialText: argument } }),
  },
  "Nexus.Quick.Page": {
    label: "New Page", alias: "/p ", category: "Create", icon: FilePlus2,
    keywords: ["page", "new page", "create page", "document"],
    target: (argument) => ({ kind: "CreatePage", titleDraft: argument || "Untitled" }),
  },
  "Nexus.Quick.Chat": {
    label: "New Chat", alias: "/c ", category: "Create", icon: MessageSquarePlus,
    keywords: ["chat", "new chat", "start chat", "conversation"],
    target: (argument) => ({ kind: "InternalHref", href: chatHref(argument), labelHint: "New chat" }),
  },
  "Nexus.Quick.Library": {
    label: "New Library", alias: "/l ", category: "Create", icon: Library,
    keywords: ["library", "new library", "create library", "collection"],
    target: (argument) => ({ kind: "CreateLibrary", nameDraft: argument }),
  },
  "Nexus.Quick.Import": {
    label: "Import", alias: "/i ", category: "Acquire", icon: Upload,
    keywords: ["add", "import", "url", "file"],
    target: (argument) => ({
      kind: "OpenAdd",
      seed: { kind: "Content", initialFocus: "Url", initialDestinations: [], ...(argument ? { initialUrlDraft: argument } : {}) },
    }),
  },
};

export type NexusIntent =
  | { readonly kind: "Search" }
  | { readonly kind: "Command"; readonly id: NexusCommandId; readonly argument: string }
  | { readonly kind: "Ask"; readonly argument: string }
  | { readonly kind: "Browse"; readonly browseKind: BrowseKind; readonly query: string }
  | { readonly kind: "ChooseBrowse"; readonly query: string }
  | { readonly kind: "ImportUrl"; readonly url: string };

export interface NexusQuery {
  /** The input trimmed; `norm` is it lowercased and keys the stable result list. */
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

function parseIntent(input: string, text: string, norm: string): NexusIntent {
  const lowered = input.toLowerCase();
  for (const id of Object.keys(NEXUS_COMMANDS) as NexusCommandId[]) {
    const { alias } = NEXUS_COMMANDS[id];
    if (!lowered.startsWith(alias)) continue;
    const argument = input.slice(alias.length).trim();
    if (id !== "Nexus.Quick.Import" || !argument) return { kind: "Command", id, argument };
    const url = singleUrl(argument);
    return url === null ? { kind: "Search" } : { kind: "Command", id, argument: url };
  }
  if (lowered.startsWith("/a ")) {
    const argument = input.slice(3).trim();
    return argument ? { kind: "Ask", argument } : { kind: "Search" };
  }
  if (lowered.startsWith("/b ")) return { kind: "ChooseBrowse", query: input.slice(3).trim() };
  const url = singleUrl(text);
  if (url !== null) return { kind: "ImportUrl", url };
  const afterOne = text.replace(/^\S+/, "").trim();
  const afterTwo = text.replace(/^\S+\s+\S+/, "").trim();
  const create = /^(?:new|create)\s+(note|page|chat|library)(?:\s+.*)?$/.exec(norm);
  if (create) return { kind: "Command", id: CREATE_NOUNS[create[1]!]!, argument: afterTwo };
  if (/^ask\s+\S/.test(norm)) return { kind: "Ask", argument: afterOne };
  const browse = /^(?:browse|find)\s+(article|podcast|video|book)(?:\s+.*)?$/.exec(norm);
  if (browse) return { kind: "Browse", browseKind: BROWSE_NOUNS[browse[1]!]!, query: afterTwo };
  if (/^(add|import)(?:\s+.*)?$/.test(norm)) {
    const addUrl = afterOne ? singleUrl(afterOne) : "";
    if (addUrl !== null) return { kind: "Command", id: "Nexus.Quick.Import", argument: addUrl };
  }
  return { kind: "Search" };
}

export function parseNexusQuery(raw: string): NexusQuery {
  const input = raw.trimStart();
  const text = input.trimEnd();
  const norm = text.toLowerCase();
  return {
    text,
    norm,
    intent: parseIntent(input, text, norm),
    searchQuery: applyParsedInput(emptySearchQuery(), parseSearchInput(text)),
  };
}
