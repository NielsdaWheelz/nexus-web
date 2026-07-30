import {
  FilePlus2,
  FileText,
  Library,
  MessageSquarePlus,
  Upload,
} from "lucide-react";
import type {
  NexusQuickAction,
  NexusQuickActionId,
} from "./model";

export const QUICK_ACTION_REGISTRY = {
  "Nexus.Quick.Note": {
    id: "Nexus.Quick.Note",
    label: "Note",
    icon: FileText,
    keywords: ["today", "capture", "journal"],
    category: "Create",
    target: { kind: "TodayCapture" },
  },
  "Nexus.Quick.Page": {
    id: "Nexus.Quick.Page",
    label: "Page",
    icon: FilePlus2,
    keywords: ["outline", "document"],
    category: "Create",
    target: { kind: "CreatePage" },
  },
  "Nexus.Quick.Chat": {
    id: "Nexus.Quick.Chat",
    label: "Chat",
    icon: MessageSquarePlus,
    keywords: ["conversation", "message"],
    category: "Create",
    target: { kind: "CreateChat" },
  },
  "Nexus.Quick.Library": {
    id: "Nexus.Quick.Library",
    label: "Library",
    icon: Library,
    keywords: ["collection"],
    category: "Create",
    target: { kind: "CreateLibrary" },
  },
  "Nexus.Quick.Import": {
    id: "Nexus.Quick.Import",
    label: "Import",
    icon: Upload,
    keywords: ["url", "file", "opml"],
    category: "Acquire",
    target: {
      kind: "Import",
      seed: {
        kind: "Content",
        initialFocus: "Url",
        initialDestinations: [],
      },
    },
  },
} as const satisfies Record<NexusQuickActionId, NexusQuickAction>;

export const SWITCHBOARD_QUICK_ACTION_IDS = [
  "Nexus.Quick.Note",
  "Nexus.Quick.Page",
  "Nexus.Quick.Chat",
  "Nexus.Quick.Library",
  "Nexus.Quick.Import",
] as const satisfies readonly NexusQuickActionId[];

export const NEXUS_ZERO_STATE_ACTION_IDS = [
  "Nexus.Quick.Chat",
  "Nexus.Quick.Note",
  "Nexus.Quick.Page",
  "Nexus.Quick.Import",
] as const satisfies readonly NexusQuickActionId[];

export function getQuickAction(
  id: NexusQuickActionId,
): NexusQuickAction {
  return QUICK_ACTION_REGISTRY[id];
}
