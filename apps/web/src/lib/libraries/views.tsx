// The libraries panes' url-owned view choices, spelled as the server reads them,
// and the one name rule. The server validates every value and every combination
// composes; these are only the options offered.

import type { Line, Verbs } from "@/components/feedback/stage";
import type { ViewChanges } from "@/lib/collections/view";

type Options = readonly { readonly value: string; readonly label: string }[];

/** The server's name rule (1–100 characters once trimmed, never All), as copy. */
export function libraryNameError(text: string): string | null {
  const name = text.trim();
  if (name === "") return "a name can’t be blank.";
  if ([...name].length > 100) return "100 characters at most.";
  return name.toLowerCase() === "all" ? "that name belongs to the all view." : null;
}

export const INDEX_SORTS: Options = [
  { value: "", label: "Oldest created" },
  { value: "created_desc", label: "Newest created" },
  { value: "name_asc", label: "Name A–Z" },
  { value: "name_desc", label: "Name Z–A" },
];

/** All's own order is newest added, so it does not offer that order twice. */
export const entrySorts = (isAll: boolean): Options => [
  { value: "", label: isAll ? "Recently added" : "Custom order" },
  { value: "title_asc", label: "Title A–Z" },
  { value: "title_desc", label: "Title Z–A" },
  { value: "creator_asc", label: "Creator A–Z" },
  { value: "creator_desc", label: "Creator Z–A" },
  { value: "published_desc", label: "First published: newest" },
  { value: "published_asc", label: "First published: oldest" },
  { value: "remaining_asc", label: "Least time left" },
  { value: "remaining_desc", label: "Most time left" },
  ...(isAll ? [] : [{ value: "added_desc", label: "Newest added" }]),
  { value: "added_asc", label: "Oldest added" },
];

export const ENTRY_TYPES: Options = [
  { value: "", label: "All types" },
  { value: "web_article", label: "Web articles" },
  { value: "epub", label: "EPUBs" },
  { value: "pdf", label: "PDFs" },
  { value: "video", label: "Videos" },
  { value: "podcast_episode", label: "Podcast episodes" },
];

/** Unfiled is a view of All only. */
export const projections = (isAll: boolean): Options => [
  { value: "", label: "All items" },
  ...(isAll ? [{ value: "unfiled", label: "Unfiled" }] : []),
  { value: "in_progress", label: "In Progress" },
];

/** An unknown current value (a hand-written url) is offered as itself, its label
 * bounded to 24 code points so the toolbar keeps its width until the server
 * refuses the view. */
export function offered(options: Options, value: string): Options {
  if (options.some((option) => option.value === value)) return options;
  const chars = Array.from(value);
  const label = chars.length > 24 ? `${chars.slice(0, 23).join("")}…` : value;
  return [...options, { value, label }];
}

/** What each type is called where a view of it is empty. */
const TYPE_PLURALS: Readonly<Record<string, string>> = {
  web_article: "web articles", epub: "epubs", pdf: "pdfs", video: "videos", podcast_episode: "podcast episodes",
};

/** A complete view's empty state: what it lacks, and the way back. */
export function emptyEntries({
  params,
  isAll,
  change,
}: {
  readonly params: URLSearchParams;
  readonly isAll: boolean;
  readonly change: (changes: ViewChanges) => void;
}): { readonly line: Line; readonly verbs?: Verbs } {
  const type = params.get("entry_type");
  const projection = params.get("projection");
  const unfinished = params.get("completion") === "unfinished";
  const verb = (label: string, changes: ViewChanges): Verbs => [{ label, commandKey: `library-view:${label}`, run: () => change(changes) }];
  const clear = verb("clear filters", { entry_type: null, projection: null, completion: null });
  if (type !== null) {
    const plural = TYPE_PLURALS[type];
    return { line: { fact: plural === undefined ? "nothing of this type here." : `no ${plural} in this view.` }, verbs: clear };
  }
  if (projection === "in_progress") return { line: { fact: "nothing in progress." }, verbs: verb("show all items", { projection: null }) };
  if (projection === "unfiled") return { line: { fact: unfinished ? "no unfinished unfiled items." : "no unfiled items." }, verbs: clear };
  if (unfinished) return { line: { fact: "no unfinished items." }, verbs: verb("show finished", { completion: null }) };
  return { line: { fact: isAll ? "nothing saved yet." : "nothing in this library yet." } };
}
