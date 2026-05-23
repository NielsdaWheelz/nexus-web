import { MessageSquare, Search } from "lucide-react";
import type { PaletteCommand } from "@/components/palette/types";

export function getAskAiPinnedCommand({
  query,
  localCommands,
  canOpenConversation,
}: {
  query: string;
  localCommands: PaletteCommand[];
  canOpenConversation: boolean;
}): PaletteCommand | null {
  const text = query.trim();
  if (text.length < 2) return null;
  if (!canOpenConversation) return null;
  if (localCommands.some((command) => command.title.toLowerCase() === text.toLowerCase())) {
    return null;
  }

  return {
    id: "ask-ai",
    title: `Ask AI about "${text}"`,
    keywords: ["ask", "ai", "chat"],
    sectionId: "ask-ai",
    icon: MessageSquare,
    target: { kind: "prefill", surface: "conversation", text },
    source: "ai",
    rank: {},
    pin: "last",
  };
}

export function getSeeAllInSearchCommand({ query }: { query: string }): PaletteCommand | null {
  const text = query.trim();
  if (text.length < 2) return null;

  return {
    id: "see-all-search",
    title: `See all results for "${text}"`,
    keywords: [],
    sectionId: "search-results",
    icon: Search,
    target: { kind: "href", href: `/search?q=${encodeURIComponent(text)}`, externalShell: false },
    source: "search",
    rank: {},
    pin: "last",
  };
}
