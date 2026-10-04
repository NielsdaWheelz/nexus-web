"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { FindRow, FindSource } from "@/lib/find/find";
import { truncatePaneSearchQuery } from "@/lib/panes/paneSearch";

const FIND_INPUT_DELAY_MS = 120;

export type FindResult =
  | { readonly kind: "Idle" | "Searching" | "TooMany" }
  | {
      readonly kind: "Rows";
      readonly rows: readonly FindRow<unknown>[];
      readonly active: number;
      readonly partial: string | null;
      readonly wrapped: "first" | "last" | null; // the step that made `active` went past an end
    }
  | { readonly kind: "Failed"; readonly message: string };

/** One pane's find session: everything the bar and the results list render or call. */
export interface FindController {
  readonly label: string;
  readonly query: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly narrow: string | null; // the narrow scope frozen at open, if the surface has one
  readonly narrowed: boolean;
  readonly result: FindResult;
  readonly returnable: boolean; // a reveal moved a surface whose way back find owns
  open(): void;
  close(): void;
  setQuery(query: string): void;
  setMatchCase(value: boolean): void;
  setWholeWord(value: boolean): void;
  setNarrowed(value: boolean): void;
  step(direction: 1 | -1): void;
  activate(index: number): Promise<boolean>;
  retry(): void;
  goBack(): void;
}

const IDLE: FindResult = { kind: "Idle" };
const NO_ROWS: readonly FindRow<unknown>[] = [];

/**
 * The one find controller. A null source publishes no find. `presentation` is
 * any value that changes when the surface re-renders the text its paint
 * resolves against while the source stays the same; each change repaints.
 * Every search, reveal, close and return aborts the operation before it: that
 * abort and the dependency on `source.key` are the whole staleness fence.
 */
export function useFind(
  source: FindSource<unknown> | null,
  presentation: unknown = null,
): FindController | null {
  const [isOpen, setOpen] = useState(false);
  const [query, setQueryState] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [narrow, setNarrow] = useState<string | null>(null);
  const [narrowed, setNarrowed] = useState(false);
  const [result, setResult] = useState<FindResult>(IDLE);
  const [returnable, setReturnable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [defect, setDefect] = useState<{ readonly error: unknown } | null>(
    null,
  );
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const resultRef = useRef(result);
  resultRef.current = result;
  const operation = useRef<AbortController | null>(null);
  const key = source?.key ?? null;

  const begin = useCallback(() => {
    operation.current?.abort();
    operation.current = new AbortController();
    return operation.current.signal;
  }, []);
  const fail = useCallback((error: unknown) => {
    if (!(error instanceof DOMException && error.name === "AbortError"))
      setDefect({ error });
  }, []);
  useEffect(() => () => operation.current?.abort(), []);

  const prepare = useCallback(() => {
    setNarrow(sourceRef.current?.prepare() ?? null);
    setNarrowed(false);
  }, []);
  useEffect(() => {
    setReturnable(false);
    if (isOpen) prepare();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- justify-eslint-override: only a new snapshot re-prepares an open session
  }, [key]);

  const reveal = useCallback(
    async (
      rows: readonly FindRow<unknown>[],
      index: number,
      signal: AbortSignal,
    ) => {
      const refusal = await sourceRef.current!.reveal(rows[index]!.at, signal);
      if (signal.aborted) return false;
      if (refusal !== null) setResult({ kind: "Failed", message: refusal });
      else if (sourceRef.current?.returnToOrigin) setReturnable(true);
      return refusal === null;
    },
    [],
  );

  useEffect(() => {
    const signal = begin();
    const current = sourceRef.current;
    setResult(current && query ? { kind: "Searching" } : IDLE);
    if (!current || !query) return;
    const timer = window.setTimeout(async () => {
      try {
        const outcome = await current.search(
          { query, matchCase, wholeWord },
          narrowed,
          signal,
        );
        if (signal.aborted) return;
        if (outcome.kind !== "Rows") return setResult(outcome);
        setResult({
          kind: "Rows",
          rows: outcome.rows,
          active: outcome.initial,
          partial: outcome.partial,
          wrapped: null,
        });
        if (outcome.rows.length > 0)
          await reveal(outcome.rows, outcome.initial, signal);
      } catch (error) {
        fail(error);
      }
    }, FIND_INPUT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [
    attempt,
    begin,
    fail,
    key,
    matchCase,
    narrowed,
    query,
    reveal,
    wholeWord,
  ]);

  const rows = result.kind === "Rows" ? result.rows : NO_ROWS;
  const active = result.kind === "Rows" ? result.active : -1;
  useLayoutEffect(
    () => source?.paint(rows, active),
    [active, presentation, rows, source],
  );
  useLayoutEffect(() => () => source?.paint(NO_ROWS, -1), [source]);

  const show = useCallback(
    async (index: number, wrapped: "first" | "last" | null) => {
      const current = resultRef.current;
      if (current.kind !== "Rows" || !current.rows[index]) return false;
      const signal = begin();
      setResult({ ...current, active: index, wrapped });
      return reveal(current.rows, index, signal).catch(
        (error: unknown) => (fail(error), false),
      );
    },
    [begin, fail, reveal],
  );

  const controller = useMemo<FindController | null>(
    () =>
      source && {
        label: source.label,
        query,
        matchCase,
        wholeWord,
        narrow,
        narrowed,
        result,
        returnable,
        setMatchCase,
        setWholeWord,
        setNarrowed,
        activate: (index) => show(index, null),
        open() {
          begin();
          setOpen(true);
          setQueryState("");
          prepare();
        },
        close() {
          begin();
          setOpen(false);
          setQueryState("");
        },
        setQuery: (next) => setQueryState(truncatePaneSearchQuery(next)),
        step(direction) {
          const current = resultRef.current;
          if (current.kind !== "Rows" || current.rows.length === 0) return;
          const next = current.active + direction;
          const count = current.rows.length;
          void show(
            (next + count) % count,
            next === count ? "first" : next < 0 ? "last" : null,
          );
        },
        retry: () => setAttempt((count) => count + 1),
        goBack() {
          begin();
          sourceRef.current?.returnToOrigin?.();
          setReturnable(false);
        },
      },
    [
      begin,
      matchCase,
      narrow,
      narrowed,
      prepare,
      query,
      result,
      returnable,
      show,
      source,
      wholeWord,
    ],
  );

  if (defect) throw defect.error;
  return controller;
}
