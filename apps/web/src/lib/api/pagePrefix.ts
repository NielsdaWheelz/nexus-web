"use client";

import { useState } from "react";
import type { Presence } from "@/lib/api/presence";
import { usePaneFreeServerValue } from "@/lib/api/serverState";

/**
 * A cursor-paged read held as its first pages (docs/modules/imports.md): every
 * `stale` change rereads that prefix, Load more asks for one page more, and a
 * new `key` starts again at one page. `short` holds while the longer read is
 * running or failed; a failed read keeps the shorter prefix.
 */
export function usePagePrefix<P extends { next_cursor: Presence<string> }>(
  key: string,
  stale: string,
  fetchPage: (cursor: string | null, signal: AbortSignal) => Promise<P>,
) {
  const [more, setMore] = useState({ key, pages: 1 });
  if (more.key !== key) setMore({ key, pages: 1 });
  const pages = more.key === key ? more.pages : 1;
  const prefix = usePaneFreeServerValue({
    key,
    stale: `${stale} ${pages}`,
    load: async (signal) => {
      const loaded: P[] = [];
      let cursor: string | null = null;
      do {
        const page = await fetchPage(cursor, signal);
        loaded.push(page);
        cursor =
          page.next_cursor.kind === "Present" ? page.next_cursor.value : null;
      } while (cursor !== null && loaded.length < pages);
      return { pages: loaded, asked: pages, more: cursor !== null };
    },
  });
  const short = prefix.status === "ready" && prefix.data.asked < pages;
  const loadMore = () => setMore({ key, pages: pages + 1 });
  return { prefix, short, loadMore };
}
