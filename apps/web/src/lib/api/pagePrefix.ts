"use client";

import { isApiError } from "@/lib/api/client";
import { useEffect, useState } from "react";
import { usePaneFreeServerValue } from "@/lib/api/serverState";

/** Read the requested bounded prefix; a stale cursor restarts at its first page. */
export async function readPagePrefix<P extends { next_cursor: string | null }>({ pages, fetchPage, signal }: {
  pages: number;
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<P>;
  signal: AbortSignal;
}) {
  const loaded: P[] = [];
  let cursor: string | null = null;
  try {
    do {
      const page = await fetchPage(cursor, signal);
      loaded.push(page);
      cursor = page.next_cursor;
    } while (cursor !== null && loaded.length < pages);
  } catch (error) {
    if (!isApiError(error) || error.status !== 409) throw error;
    // A version-bound cursor invalidates the prefix, not just its last page.
    const first = await fetchPage(null, signal);
    return { pages: [first], asked: 1, more: first.next_cursor !== null };
  }
  return { pages: loaded, asked: pages, more: cursor !== null };
}

/**
 * A cursor-paged read held as its first pages (docs/modules/imports.md): every
 * `stale` change rereads that prefix, Load more asks for one page more, and a
 * new `key` starts again at one page. `short` holds while the longer read is
 * running or failed; a failed read keeps the shorter prefix.
 */
export function usePagePrefix<P extends { next_cursor: string | null }>(
  key: string | null,
  stale: string,
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<P>,
) {
  const [more, setMore] = useState({ key, pages: 1 });
  if (more.key !== key) setMore({ key, pages: 1 });
  const pages = more.key === key ? more.pages : 1;
  const prefix = usePaneFreeServerValue({
    key,
    stale,
    readPolicy: `prefix:retry3:pages=${pages}`,
    load: signal => readPagePrefix({ pages, fetchPage, signal }),
  });
  const asked = prefix.status === "ready" ? prefix.data.asked : null;
  useEffect(() => {
    if (asked !== null && asked < pages) setMore({ key, pages: asked });
  }, [asked, key, pages]);
  const short = prefix.status === "ready" && prefix.data.asked < pages;
  const loadMore = () => setMore({ key, pages: pages + 1 });
  return { prefix, short, loadMore };
}
