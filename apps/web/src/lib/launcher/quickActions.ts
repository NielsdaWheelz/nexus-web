import {
  FilePlus2,
  FileText,
  Library,
  MessageSquarePlus,
  Mic,
  Upload,
  type LucideIcon,
} from "lucide-react";
import type { AddSeed } from "./model";

export type SwitchboardQuickActionId =
  | "Nexus.Quick.Note"
  | "Nexus.Quick.Page"
  | "Nexus.Quick.Chat"
  | "Nexus.Quick.Library"
  | "Nexus.Quick.Import"
  | "Nexus.Quick.Podcast";

export type SwitchboardQuickActionTarget =
  | { kind: "TodayCapture" }
  | { kind: "CreatePage" }
  | { kind: "CreateChat" }
  | { kind: "CreateLibrary" }
  | { kind: "Import"; seed: AddSeed }
  | { kind: "PodcastDiscovery" };

export interface SwitchboardQuickAction {
  id: SwitchboardQuickActionId;
  label: string;
  icon: LucideIcon;
  keywords: readonly string[];
  category: "Create" | "Acquire";
  target: SwitchboardQuickActionTarget;
}

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
  "Nexus.Quick.Podcast": {
    id: "Nexus.Quick.Podcast",
    label: "Podcast",
    icon: Mic,
    keywords: ["discover", "subscribe", "feed"],
    category: "Acquire",
    target: { kind: "PodcastDiscovery" },
  },
} as const satisfies Record<SwitchboardQuickActionId, SwitchboardQuickAction>;

export const SWITCHBOARD_QUICK_ACTION_IDS = [
  "Nexus.Quick.Note",
  "Nexus.Quick.Page",
  "Nexus.Quick.Chat",
  "Nexus.Quick.Library",
  "Nexus.Quick.Import",
  "Nexus.Quick.Podcast",
] as const satisfies readonly SwitchboardQuickActionId[];

export const DESKTOP_CREATE_ACTION_IDS = [
  "Nexus.Quick.Chat",
  "Nexus.Quick.Page",
  "Nexus.Quick.Note",
] as const satisfies readonly SwitchboardQuickActionId[];

export function getQuickAction(
  id: SwitchboardQuickActionId,
): SwitchboardQuickAction {
  return QUICK_ACTION_REGISTRY[id];
}
