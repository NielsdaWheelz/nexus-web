import { MessageSquare } from "lucide-react";
import type { PaletteCommand } from "@/components/palette/types";

export function getAskAiFallbackCommand({
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
  };
}
