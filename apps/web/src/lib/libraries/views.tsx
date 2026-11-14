// The libraries panes' url grammar, view choices and shared name rules.

import type { Line, Verbs } from "@/components/feedback/stage";
import type { ViewChanges } from "@/lib/collections/view";

type Options = readonly { readonly value: string; readonly label: string }[];

export const ENTRY_TYPES = [
  { value: "web_article", label: "articles" },
  { value: "epub", label: "epubs" },
  { value: "pdf", label: "pdfs" },
  { value: "video", label: "videos" },
  { value: "podcast_episode", label: "episodes" },
] as const;

const LIBRARY_SORTS = ["title_asc", "title_desc", "creator_asc", "creator_desc", "published_desc", "published_asc", "remaining_asc", "remaining_desc", "added_desc", "added_asc"] as const;
const LIBRARY_PROJECTIONS = ["unfinished", "in_progress", "unfiled"] as const;

type LibraryView = {
  sort: typeof LIBRARY_SORTS[number] | null;
  entry_type: typeof ENTRY_TYPES[number]["value"] | null;
  projection: typeof LIBRARY_PROJECTIONS[number] | null;
};

/** The whole pane url is a view; malformed urls never initiate a read. */
export function decodeEmptyView(params: URLSearchParams): boolean {
  return [...params].length === 0;
}
export function decodeLibraryView(params: URLSearchParams): LibraryView | null {
  const choices = { sort: LIBRARY_SORTS, entry_type: ENTRY_TYPES.map(option => option.value), projection: LIBRARY_PROJECTIONS };
  for (const [key, value] of params) {
    if (!Object.hasOwn(choices, key) || params.getAll(key).length !== 1 ||
      !(choices[key as keyof typeof choices] as readonly string[]).includes(value)) return null;
  }
  if (params.get("projection") === "unfiled" && params.get("sort") === "added_desc") return null;
  return {
    sort: LIBRARY_SORTS.find(value => value === params.get("sort")) ?? null,
    entry_type: ENTRY_TYPES.find(option => option.value === params.get("entry_type"))?.value ?? null,
    projection: LIBRARY_PROJECTIONS.find(value => value === params.get("projection")) ?? null,
  };
}

/** Only these choices depend on whether the library is All. */
export function libraryViewNeedsIdentity(view: LibraryView): boolean {
  return view.projection === "unfiled" || view.sort === "added_desc";
}

/** The server's name rule (1–100 characters once trimmed, never All), as copy. */
export function libraryNameError(text: string): string | null {
  const name = text.trim();
  if (name === "") return "a name can’t be blank.";
  if ([...name].length > 100) return "100 characters at most.";
  return name.toLowerCase() === "all" ? "that name belongs to the all view." : null;
}

/** Library names as every chooser lists them: case-blind, then exact, then by id. */
export function compareLibraryNames(a: { id: string; name: string }, b: { id: string; name: string }) {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id.localeCompare(b.id));
}

/** Libraries in one short phrase: one or two in full, else the first two and how many more. */
export function libraryNames(libraries: readonly { id: string; name: string }[]): string {
  const names = libraries.toSorted(compareLibraryNames).map(library => library.name);
  return names.length <= 2 ? names.join(", ") : `${names[0]}, ${names[1]} +${names.length - 2}`;
}

/** Unfiled is a view of All only. */
export const projections = (isAll: boolean): Options => [
  { value: "", label: "all items" },
  { value: "unfinished", label: "unfinished" },
  { value: "in_progress", label: "in progress" },
  ...(isAll ? [{ value: "unfiled", label: "unfiled" }] : []),
];

/** A complete view's empty state: what it lacks, and the way back. */
export function emptyEntries({
  view,
  isAll,
  change,
}: {
  readonly view: Pick<LibraryView, "entry_type" | "projection">;
  readonly isAll: boolean;
  readonly change: (changes: ViewChanges) => void;
}): { readonly line: Line; readonly verbs?: Verbs } {
  const { entry_type: type, projection } = view;
  const verb = (label: string, changes: ViewChanges): Verbs => [{ label, commandKey: `library-view:${label}`, run: () => change(changes) }];
  const clear = verb("show all types", { entry_type: null });
  if (type !== null) {
    // justify-type-assertion: the decoder admits only the published type options.
    const plural = ENTRY_TYPES.find(option => option.value === type)!.label;
    return { line: { fact: `no ${plural} in this view.` }, verbs: clear };
  }
  if (projection === "in_progress") return { line: { fact: "nothing in progress." }, verbs: verb("show all items", { projection: null }) };
  if (projection === "unfiled") return { line: { fact: "no unfiled items." }, verbs: verb("show all items", { projection: null }) };
  if (projection === "unfinished") return { line: { fact: "no unfinished items." }, verbs: verb("show all items", { projection: null }) };
  return { line: { fact: isAll ? "nothing saved yet." : "nothing in this library yet." } };
}
