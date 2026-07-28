import { absent, present, type Presence } from "@/lib/api/presence";
import type { ResourceScheme } from "@/lib/resourceGraph/resourceRef";
import type { SearchKind } from "@/lib/search/kinds";
import {
  emptySearchQuery,
  type SearchQuery,
} from "@/lib/search/query";
import type { SwitchboardFindScope } from "./model";

interface SwitchboardFindProfile {
  schemes: Presence<ResourceScheme[]>;
  searchKinds: readonly SearchKind[] | null;
}

const FIND_PROFILES: Record<SwitchboardFindScope, SwitchboardFindProfile> = {
  All: {
    schemes: absent(),
    searchKinds: [
      "documents",
      "notes",
      "highlights",
      "conversations",
      "people",
    ],
  },
  Media: {
    schemes: present(["media", "podcast"]),
    searchKinds: ["documents"],
  },
  Notes: {
    schemes: present(["page", "note_block"]),
    searchKinds: ["notes"],
  },
  Highlights: {
    schemes: present(["highlight"]),
    searchKinds: ["highlights"],
  },
  Chats: {
    schemes: present([
      "conversation",
      "message",
      "artifact",
      "artifact_revision",
    ]),
    searchKinds: ["conversations"],
  },
  Libraries: {
    schemes: present(["library"]),
    searchKinds: null,
  },
  People: {
    schemes: present(["contributor"]),
    searchKinds: ["people"],
  },
};

export function switchboardOpenableSchemes(
  scope: SwitchboardFindScope,
): Presence<ResourceScheme[]> {
  return FIND_PROFILES[scope].schemes;
}

export function switchboardSearchQuery(
  scope: SwitchboardFindScope,
  rawQuery: string,
): SearchQuery | null {
  const kinds = FIND_PROFILES[scope].searchKinds;
  if (kinds === null) return null;
  return {
    ...emptySearchQuery(),
    text: rawQuery.trim(),
    requestedKinds: new Set(kinds),
  };
}
