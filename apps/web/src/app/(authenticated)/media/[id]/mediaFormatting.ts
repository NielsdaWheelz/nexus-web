"use client";

export interface MediaAuthor {
  id: string;
  name: string;
  role: string | null;
}

export interface Media {
  title: string;
  authors: MediaAuthor[];
}

function getMediaAuthorNames(
  authors: MediaAuthor[] | null | undefined
): string[] {
  if (!Array.isArray(authors)) {
    return [];
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const author of authors) {
    const name = author?.name?.trim();
    if (!name) {
      continue;
    }
    const dedupeKey = name.toLocaleLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    names.push(name);
  }
  return names;
}

export function formatMediaAuthors(
  authors: MediaAuthor[] | null | undefined,
  maxNames: number = Number.POSITIVE_INFINITY
): string | null {
  const names = getMediaAuthorNames(authors);
  if (names.length === 0) {
    return null;
  }

  const visibleCount =
    Number.isFinite(maxNames) && maxNames > 0
      ? Math.max(1, Math.floor(maxNames))
      : names.length;

  if (names.length <= visibleCount) {
    return names.join(", ");
  }

  return `${names.slice(0, visibleCount).join(", ")} +${names.length - visibleCount}`;
}

export function buildCompactMediaPaneTitle(
  media: Pick<Media, "title" | "authors"> | null | undefined
): string {
  const title = media?.title?.trim();
  if (!title) {
    return "Media";
  }

  const authorSummary = formatMediaAuthors(media?.authors, 1);
  if (!authorSummary) {
    return title;
  }

  const compactTitle = `${title} · ${authorSummary}`;
  return compactTitle.length <= 56 ? compactTitle : title;
}

export function formatResumeTime(positionMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(positionMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}
