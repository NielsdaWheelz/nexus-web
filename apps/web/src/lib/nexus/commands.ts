import {
  FilePlus2,
  FileText,
  Library,
  MessageSquarePlus,
  Upload,
} from "lucide-react";
import type { NexusCommand, NexusCommandId } from "./model";

export const NEXUS_COMMAND_IDS = [
  "Nexus.Quick.Note",
  "Nexus.Quick.Page",
  "Nexus.Quick.Chat",
  "Nexus.Quick.Library",
  "Nexus.Quick.Import",
] as const satisfies readonly NexusCommandId[];

export const NEXUS_COMMAND_REGISTRY = {
  "Nexus.Quick.Note": {
    id: "Nexus.Quick.Note",
    label: "Quick Note",
    aliases: ["/n "],
    keywords: ["note", "new note", "create note", "jot", "capture"],
    category: "Create",
    icon: FileText,
    activation: { kind: "DailyTextHandoff" },
    shortcut: {
      kind: "Keybinding",
      actionId: "Nexus.Quick.Note",
    },
    target: ({ argument }) => ({
      kind: "OpenDailyPage",
      date: { kind: "Today" },
      entry: { kind: "AppendNote", initialText: argument },
    }),
  },
  "Nexus.Quick.Page": {
    id: "Nexus.Quick.Page",
    label: "New Page",
    aliases: ["/p "],
    keywords: ["page", "new page", "create page", "document"],
    category: "Create",
    icon: FilePlus2,
    activation: { kind: "Standard" },
    shortcut: {
      kind: "Keybinding",
      actionId: "Nexus.Quick.Page",
    },
    target: ({ argument }) => ({
      kind: "CreatePage",
      titleDraft: argument || "Untitled",
    }),
  },
  "Nexus.Quick.Chat": {
    id: "Nexus.Quick.Chat",
    label: "New Chat",
    aliases: ["/c "],
    keywords: ["chat", "new chat", "start chat", "conversation"],
    category: "Create",
    icon: MessageSquarePlus,
    activation: { kind: "Standard" },
    shortcut: {
      kind: "Keybinding",
      actionId: "Nexus.Quick.Chat",
    },
    target: ({ argument }) => ({
      kind: "NewConversation",
      initialDraft: argument,
    }),
  },
  "Nexus.Quick.Library": {
    id: "Nexus.Quick.Library",
    label: "New Library",
    aliases: ["/l "],
    keywords: ["library", "new library", "create library", "collection"],
    category: "Create",
    icon: Library,
    activation: { kind: "Standard" },
    shortcut: {
      kind: "Keybinding",
      actionId: "Nexus.Quick.Library",
    },
    target: ({ argument }) => ({
      kind: "CreateLibrary",
      nameDraft: argument,
    }),
  },
  "Nexus.Quick.Import": {
    id: "Nexus.Quick.Import",
    label: "Import",
    aliases: ["/i "],
    keywords: ["add", "import", "url", "file", "opml"],
    category: "Acquire",
    icon: Upload,
    activation: { kind: "Standard" },
    shortcut: {
      kind: "Keybinding",
      actionId: "Nexus.Quick.Import",
    },
    target: ({ argument }) => ({
      kind: "OpenAdd",
      seed: {
        kind: "Content",
        initialFocus: "Url",
        initialDestinations: [],
        ...(argument ? { initialUrlDraft: argument } : {}),
      },
    }),
  },
} as const satisfies Record<NexusCommandId, NexusCommand>;

export function getNexusCommand(id: NexusCommandId): NexusCommand {
  return NEXUS_COMMAND_REGISTRY[id];
}

export function isNexusCommandId(value: string): value is NexusCommandId {
  return Object.hasOwn(NEXUS_COMMAND_REGISTRY, value);
}
