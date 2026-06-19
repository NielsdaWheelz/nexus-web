"use client";

// Per-pane "read filters/sort from the pane URL, write them back via the pane
// router" pattern (CT-5), consolidated into one owner. The URL is the single
// source of truth; `state` is derived from the pane search params and `setState`
// re-encodes into a pane-router replace. Callers supply a value-object⇄
// URLSearchParams codec (see lib/search/searchParams.ts for the precedent).

import { useCallback, useMemo } from "react";
import {
  usePaneRouter,
  usePaneSearchParams,
  type PaneRouterOptions,
} from "@/lib/panes/paneRuntime";

export interface PaneUrlStateCodec<T> {
  decode: (params: URLSearchParams) => T;
  encode: (value: T, currentParams: URLSearchParams) => URLSearchParams;
  basePath: string;
  replaceOptions?: PaneRouterOptions;
}

export function usePaneUrlState<T>(
  codec: PaneUrlStateCodec<T>,
): { state: T; setState: (next: T) => void } {
  const params = usePaneSearchParams();
  const router = usePaneRouter();
  const search = params.toString();
  const state = useMemo(
    () => codec.decode(new URLSearchParams(search)),
    // Identity is stable on the raw search string; the codec is treated as fixed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search],
  );
  const setState = useCallback(
    (next: T) => {
      const qs = codec.encode(next, new URLSearchParams(search)).toString();
      router.replace(
        qs ? `${codec.basePath}?${qs}` : codec.basePath,
        codec.replaceOptions,
      );
    },
    [codec, router, search],
  );
  return { state, setState };
}
