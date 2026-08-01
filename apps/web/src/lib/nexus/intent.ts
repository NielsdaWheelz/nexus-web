import { extractUrls } from "@/lib/extractUrls";
import { NEXUS_COMMAND_IDS, NEXUS_COMMAND_REGISTRY } from "./commands";
import type { NexusCommandId } from "./model";

export type NexusIntent =
  | { readonly kind: "Search" }
  | {
      readonly kind: "Command";
      readonly commandId: NexusCommandId;
      readonly argument: string;
    }
  | { readonly kind: "Ask"; readonly argument: string }
  | {
      readonly kind: "Browse";
      readonly browseKind: "WebArticle" | "Podcast" | "Video" | "Epub";
      readonly query: string;
    }
  | { readonly kind: "ChooseBrowse"; readonly query: string }
  | { readonly kind: "ImportUrl"; readonly url: string };

export interface CompiledNexusIntent {
  readonly query: string;
  readonly normalizedQuery: string;
  readonly intent: NexusIntent;
}

const CREATE_COMMAND_BY_NOUN = {
  note: "Nexus.Quick.Note",
  page: "Nexus.Quick.Page",
  chat: "Nexus.Quick.Chat",
  library: "Nexus.Quick.Library",
} as const satisfies Record<string, NexusCommandId>;

const BROWSE_KIND_BY_NOUN = {
  article: "WebArticle",
  podcast: "Podcast",
  video: "Video",
  book: "Epub",
} as const;

function canonicalUrl(value: string): string | null {
  const urls = extractUrls(value);
  if (urls.length !== 1 || urls[0] !== value) return null;
  return new URL(urls[0]).toString();
}

function search(
  query: string,
  normalizedQuery: string,
): CompiledNexusIntent {
  return { query, normalizedQuery, intent: { kind: "Search" } };
}

function argumentAfterWords(query: string, count: number): string {
  let cursor = 0;
  for (let index = 0; index < count; index += 1) {
    const word = query.slice(cursor).match(/^\S+/)?.[0];
    if (!word) return "";
    cursor += word.length;
    const whitespace = query.slice(cursor).match(/^\s+/)?.[0] ?? "";
    cursor += whitespace.length;
  }
  return query.slice(cursor).trim();
}

export function compileNexusIntent(raw: string): CompiledNexusIntent {
  const slashInput = raw.trimStart();
  const normalizedSlashInput = slashInput.toLowerCase();
  const query = slashInput.trimEnd();
  const normalizedQuery = normalizedSlashInput.trimEnd();

  for (const commandId of NEXUS_COMMAND_IDS) {
    const command = NEXUS_COMMAND_REGISTRY[commandId];
    const alias = command.aliases.find((candidate) =>
      normalizedSlashInput.startsWith(candidate),
    );
    if (!alias) continue;
    const remainder = slashInput.slice(alias.length).trim();
    if (commandId === "Nexus.Quick.Import") {
      const url = remainder ? canonicalUrl(remainder) : "";
      return remainder && url === null
        ? search(query, normalizedQuery)
        : {
            query,
            normalizedQuery,
            intent: { kind: "Command", commandId, argument: url || "" },
          };
    }
    return {
      query,
      normalizedQuery,
      intent: { kind: "Command", commandId, argument: remainder },
    };
  }

  if (normalizedSlashInput.startsWith("/a ")) {
    const argument = slashInput.slice(3).trim();
    return argument
      ? { query, normalizedQuery, intent: { kind: "Ask", argument } }
      : search(query, normalizedQuery);
  }
  if (normalizedSlashInput.startsWith("/b ")) {
    return {
      query,
      normalizedQuery,
      intent: { kind: "ChooseBrowse", query: slashInput.slice(3).trim() },
    };
  }

  const bareUrl = canonicalUrl(query);
  if (bareUrl !== null) {
    return {
      query,
      normalizedQuery,
      intent: { kind: "ImportUrl", url: bareUrl },
    };
  }

  const create = normalizedQuery.match(
    /^(?:new|create)\s+(note|page|chat|library)(?:\s+.*)?$/,
  );
  if (create) {
    return {
      query,
      normalizedQuery,
      intent: {
        kind: "Command",
        commandId:
          CREATE_COMMAND_BY_NOUN[create[1] as keyof typeof CREATE_COMMAND_BY_NOUN],
        argument: argumentAfterWords(query, 2),
      },
    };
  }

  if (/^ask\s+\S/.test(normalizedQuery)) {
    return {
      query,
      normalizedQuery,
      intent: { kind: "Ask", argument: argumentAfterWords(query, 1) },
    };
  }

  const browse = normalizedQuery.match(
    /^(?:browse|find)\s+(article|podcast|video|book)(?:\s+.*)?$/,
  );
  if (browse) {
    return {
      query,
      normalizedQuery,
      intent: {
        kind: "Browse",
        browseKind:
          BROWSE_KIND_BY_NOUN[browse[1] as keyof typeof BROWSE_KIND_BY_NOUN],
        query: argumentAfterWords(query, 2),
      },
    };
  }

  const add = normalizedQuery.match(/^(add|import)(?:\s+(.*))?$/);
  if (add) {
    const argument = argumentAfterWords(query, 1);
    if (!argument) {
      return {
        query,
        normalizedQuery,
        intent: {
          kind: "Command",
          commandId: "Nexus.Quick.Import",
          argument: "",
        },
      };
    }
    const url = canonicalUrl(argument);
    if (url !== null) {
      return {
        query,
        normalizedQuery,
        intent: {
          kind: "Command",
          commandId: "Nexus.Quick.Import",
          argument: url,
        },
      };
    }
  }

  return search(query, normalizedQuery);
}
