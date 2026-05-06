import type { PaletteCommand, PaletteSection } from "@/components/palette/types";

const SECTION_ORDER: Record<string, number> = {
  "top-result": 0,
  "search-results": 10,
  "open-tabs": 20,
  recent: 30,
  "recent-folios": 40,
  create: 50,
  navigate: 60,
  settings: 70,
  "ask-ai": 80,
};

const SECTION_LABELS: Record<string, string> = {
  "top-result": "Top result",
  "search-results": "Search results",
  "open-tabs": "Open tabs",
  recent: "Recent",
  "recent-folios": "Recent folios",
  create: "Create",
  navigate: "Navigate",
  settings: "Settings",
  "ask-ai": "Ask AI",
};

export function sectionFor(id: string): PaletteSection {
  return { id, label: SECTION_LABELS[id] ?? id, order: SECTION_ORDER[id] ?? 1000 };
}

export function rankPaletteCommands({
  query,
  commands,
  frecencyBoosts,
  currentWorkspaceHref,
}: {
  query: string;
  commands: PaletteCommand[];
  frecencyBoosts: Map<string, number>;
  currentWorkspaceHref: string | null;
}): {
  topResult: PaletteCommand | null;
  displaySections: PaletteSection[];
  displayCommands: PaletteCommand[];
} {
  const normalizedQuery = query.trim().toLowerCase();
  const scored = commands
    .map((command, index) => {
      const title = command.title.toLowerCase();
      const words = title.split(/\s+/);
      let score = 0;

      if (!normalizedQuery) {
        score = command.rank.recencyBoost ?? 0;
      } else if (title === normalizedQuery) {
        score = 10000;
      } else if (title.startsWith(normalizedQuery)) {
        score = 8500;
      } else if (words.some((word) => word.startsWith(normalizedQuery))) {
        score = 7000;
      } else if (command.keywords.some((keyword) => keyword.toLowerCase() === normalizedQuery)) {
        score = 6500;
      } else if (command.keywords.some((keyword) => keyword.toLowerCase().includes(normalizedQuery))) {
        score = 5200;
      } else if (title.includes(normalizedQuery)) {
        score = 5000;
      } else if (isOrderedSubsequence(normalizedQuery, title)) {
        score = 3000;
      } else {
        score = command.source === "search" ? 1000 : 0;
      }

      score += command.rank.searchScore ? command.rank.searchScore * 1000 : 0;
      score += frecencyBoosts.get(command.id) ?? command.rank.frecencyBoost ?? 0;
      score += command.rank.recencyBoost ?? 0;
      score += command.rank.scopeBoost ?? 0;

      if (currentWorkspaceHref && command.target.kind === "href" && command.target.href === currentWorkspaceHref) {
        score += 250;
      }
      if (command.danger) score -= 250;
      if (command.disabled) score -= 10000;

      return { command, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const topResult = normalizedQuery ? (scored.find((item) => !item.command.disabled)?.command ?? null) : null;
  const displayCommands = topResult
    ? [
        { ...topResult, sectionId: "top-result" },
        ...commands.filter((command) => command.id !== topResult.id),
      ]
    : commands;

  const usedSectionIds = new Set(displayCommands.map((command) => command.sectionId));
  const displaySections = Array.from(usedSectionIds)
    .map(sectionFor)
    .sort((a, b) => a.order - b.order);

  return { topResult, displaySections, displayCommands };
}

function isOrderedSubsequence(query: string, title: string): boolean {
  let cursor = 0;
  for (const char of query) {
    cursor = title.indexOf(char, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}
