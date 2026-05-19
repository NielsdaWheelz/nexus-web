import type { PaletteCommand, PaletteGroup, PaletteView } from "@/components/palette/types";

const RESTING_SECTIONS: { id: string; label: string }[] = [
  { id: "in-this-pane", label: "In this pane" },
  { id: "open-tabs", label: "Open tabs" },
  { id: "recent", label: "Recent" },
  { id: "recent-folios", label: "Recent folios" },
  { id: "create", label: "Create" },
  { id: "navigate", label: "Go to" },
  { id: "settings", label: "Settings" },
];

const SCOPE_FILTER_AFFINITY_BOOST = 1500;

export function buildPaletteView({
  query,
  commands,
  frecencyBoosts,
  currentWorkspaceHref,
  scopeFilter,
  inThisPaneLabel,
}: {
  query: string;
  commands: PaletteCommand[];
  frecencyBoosts: Map<string, number>;
  currentWorkspaceHref: string | null;
  scopeFilter: string | null;
  inThisPaneLabel: string | null;
}): PaletteView {
  const normalizedQuery = query.trim().toLowerCase();
  const filteredCommands =
    scopeFilter === null
      ? commands
      : commands.filter((command) => command.scopeAffinity?.includes(scopeFilter) ?? false);

  const scored = filteredCommands
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
      if (scopeFilter === null) {
        score += command.rank.scopeBoost ?? 0;
      } else if (command.scopeAffinity?.includes(scopeFilter)) {
        score += SCOPE_FILTER_AFFINITY_BOOST;
      }

      if (currentWorkspaceHref && command.target.kind === "href" && command.target.href === currentWorkspaceHref) {
        score += 250;
      }
      if (command.danger) score -= 250;
      if (command.disabled) score -= 10000;

      return { command, score, index };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index);

  if (!normalizedQuery) {
    const groups: PaletteGroup[] = [];
    for (const section of RESTING_SECTIONS) {
      const commandsInSection = scored
        .filter((item) => item.command.sectionId === section.id)
        .map((item) => item.command);
      if (commandsInSection.length === 0) continue;
      const label =
        section.id === "in-this-pane" && inThisPaneLabel !== null ? inThisPaneLabel : section.label;
      groups.push({ sectionId: section.id, label, commands: commandsInSection });
    }
    return { state: "resting", groups };
  }

  const ranked = scored.map((item) => item.command);
  const results = [
    ...ranked.filter((command) => command.pin !== "last"),
    ...ranked.filter((command) => command.pin === "last"),
  ];
  return { state: "querying", results };
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
