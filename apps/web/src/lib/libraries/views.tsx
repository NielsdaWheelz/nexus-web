// The libraries panes' url-owned view choices, spelled as the server reads them,
// and the one name rule. The server validates every value and every combination
// composes; these are only the options offered.

import { FeedbackNotice } from "@/components/feedback/Feedback";
import type { ViewChanges } from "@/lib/collections/view";

type Options = readonly { readonly value: string; readonly label: string }[];

/** The server's name rule (1–100 characters once trimmed, never All), as copy. */
export function libraryNameError(text: string): string | null {
  const name = text.trim();
  if (name === "") return "enter a library name.";
  if ([...name].length > 100) return "use 100 characters or fewer.";
  return name.toLowerCase() === "all" ? "All is reserved for the All view." : null;
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
  { value: "published_desc", label: "Newest published" },
  { value: "published_asc", label: "Oldest published" },
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
  { value: "podcast", label: "Podcast shows" },
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

/** A complete view's empty state: what it lacks, and the way back. */
export function EmptyEntries({
  params,
  isAll,
  change,
}: {
  readonly params: URLSearchParams;
  readonly isAll: boolean;
  readonly change: (changes: ViewChanges) => void;
}) {
  const type = params.get("entry_type");
  const projection = params.get("projection");
  const unfinished = params.get("completion") === "unfinished";
  const clear = {
    label: "Clear filters",
    onClick: () =>
      change({ entry_type: null, projection: null, completion: null }),
  };
  const typeLabel = ENTRY_TYPES.find((option) => option.value === type)?.label;
  const [title, action] =
    type !== null
      ? [`No matches for “${typeLabel ?? type}” in this view.`, clear]
      : projection === "in_progress"
        ? [
            "Nothing in progress.",
            { label: "Show all items", onClick: () => change({ projection: null }) },
          ]
        : projection === "unfiled"
          ? [unfinished ? "No unfinished unfiled items." : "no unfiled items", clear]
          : unfinished
            ? [
                "No unfinished items.",
                { label: "Show finished", onClick: () => change({ completion: null }) },
              ]
            : [isAll ? "No media yet." : "No podcasts or media in this library yet.", null];
  return (
    <FeedbackNotice
      content={{ tone: "Neutral", title }}
      announcement="Polite"
      actions={action ? [action] : undefined}
    />
  );
}
