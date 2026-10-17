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
import { truncatePaneSearchQuery } from "@/lib/panes/paneChrome";

const FIND_INPUT_DELAY_MS = 120;

export type FindResult =
  | { readonly kind: "Idle" | "Searching" | "TooMany" }
  | {
      readonly kind: "Rows";
      readonly rows: readonly FindRow<unknown>[];
      readonly active: number;
      readonly partial: string | null;
      readonly wrapped: "first" | "last" | null;
    }
  | { readonly kind: "Failed"; readonly message: string };

/** One pane's find session, independent of whether its input is visible. */
export interface FindController {
  readonly label: string;
  readonly query: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly narrowLabel: string | null;
  readonly narrow: string | null; // scope captured by the first nonempty query
  readonly narrowed: boolean;
  readonly result: FindResult;
  readonly returnable: boolean;
  clear(): void;
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

interface Session {
  readonly ownerKey: string;
  readonly sourceKey: string | null;
  readonly query: string;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  readonly narrowed: boolean;
  readonly narrow: string | null;
  readonly result: FindResult;
  readonly returnable: boolean;
  readonly attempt: number;
  readonly defect: { readonly error: unknown } | null;
}

/**
 * A new pane owner starts fresh. A new publication keeps text and preferences,
 * but recaptures geometry after the replacement source is ready. `presentation`
 * changes repaint text that was rerendered without changing its publication.
 */
export function useFind({
  ownerKey,
  source,
  presentation,
}: {
  readonly ownerKey: string;
  readonly source: FindSource<unknown> | null;
  readonly presentation?: unknown;
}): FindController | null {
  const key = source?.key ?? null;
  const initial: Session = {
    ownerKey,
    sourceKey: key,
    query: "",
    matchCase: false,
    wholeWord: false,
    narrowed: false,
    narrow: null,
    result: IDLE,
    returnable: false,
    attempt: 0,
    defect: null,
  };
  const [session, setSession] = useState(initial);
  // Adjust before publishing: replacement panes must never render old results.
  if (session.ownerKey !== ownerKey) setSession(initial);
  else if (session.sourceKey !== key)
    setSession({
      ...session,
      sourceKey: key,
      narrow: null,
      result: IDLE,
      returnable: false,
      defect: null,
    });
  const latest = useRef(session);
  latest.current = session;
  const [lifetime, setLifetime] = useState<{
    readonly ownerKey: string;
    readonly sourceKey: string | null;
    computation: AbortController | null;
    movement: AbortController | null;
    autoRevealAllowed: boolean;
    prepared: boolean;
  }>({
    ownerKey,
    sourceKey: key,
    computation: null,
    movement: null,
    autoRevealAllowed: true,
    prepared: false,
  });
  if (lifetime.ownerKey !== ownerKey || lifetime.sourceKey !== key)
    setLifetime({
      ownerKey,
      sourceKey: key,
      computation: null,
      movement: null,
      autoRevealAllowed: true,
      prepared: false,
    });
  useLayoutEffect(
    () => () => {
      lifetime.computation?.abort();
      lifetime.movement?.abort();
    },
    [lifetime],
  );
  const update = useCallback(
    (patch: Partial<Session>) =>
      setSession((current) =>
        current.ownerKey === lifetime.ownerKey && current.sourceKey === lifetime.sourceKey
          ? { ...current, ...patch }
          : current,
      ),
    [lifetime],
  );
  const beginMovement = useCallback(() => {
    lifetime.movement?.abort();
    const movement = new AbortController();
    lifetime.movement = movement;
    return movement;
  }, [lifetime]);
  const prepare = useCallback(() => {
    if (!source || lifetime.prepared) return;
    lifetime.prepared = true;
    update({ narrow: source.prepare() });
  }, [lifetime, source, update]);
  const fail = useCallback(
    (error: unknown, signal: AbortSignal) => {
      if (
        !signal.aborted &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        update({ defect: { error } });
    },
    [update],
  );
  const reveal = useCallback(
    async (
      rows: readonly FindRow<unknown>[],
      index: number,
      signal: AbortSignal,
    ) => {
      if (!source || signal.aborted) return false;
      const outcome = await source.reveal(rows[index]!.at, signal);
      if (signal.aborted || outcome.kind === "Cancelled") return false;
      if (outcome.kind === "Failed") {
        update({ result: outcome });
        return false;
      }
      if (source.returnToOrigin) update({ returnable: true });
      return true;
    },
    [source, update],
  );
  const { query, matchCase, wholeWord, narrowed, result, attempt } = session;
  useEffect(() => {
    lifetime.computation?.abort();
    const computation = new AbortController();
    lifetime.computation = computation;
    const { signal } = computation;
    update({ result: source && query ? { kind: "Searching" } : IDLE });
    if (!source || !query) return () => computation.abort();
    prepare();
    let automaticMovement: AbortController | null = null;
    const timer = window.setTimeout(async () => {
      if (signal.aborted) return;
      try {
        const outcome =
          narrowed && source.narrowLabel === null
            ? {
                kind: "Failed" as const,
                message:
                  "Selected scope is unavailable. Turn off the scope option to search all content.",
              }
            : await source.search({ query, matchCase, wholeWord }, narrowed, signal);
        if (signal.aborted) return;
        if (outcome.kind !== "Rows") return update({ result: outcome });
        update({
          result: {
            kind: "Rows",
            rows: outcome.rows,
            active: outcome.initial,
            partial: outcome.partial,
            wrapped: null,
          },
        });
        if (outcome.rows.length > 0 && !signal.aborted && lifetime.autoRevealAllowed) {
          const movement = beginMovement();
          automaticMovement = movement;
          await reveal(outcome.rows, outcome.initial, movement.signal).catch(
            (error: unknown) => fail(error, movement.signal),
          );
        }
      } catch (error) {
        fail(error, signal);
      }
    }, FIND_INPUT_DELAY_MS);
    return () => {
      window.clearTimeout(timer);
      computation.abort();
      automaticMovement?.abort();
    };
  }, [attempt, beginMovement, fail, lifetime, matchCase, narrowed, prepare, query, reveal, source, update, wholeWord]);

  const rows = result.kind === "Rows" ? result.rows : NO_ROWS;
  const active = result.kind === "Rows" ? result.active : -1;
  useLayoutEffect(
    () => source?.paint(rows, active),
    [active, presentation, rows, source],
  );
  useLayoutEffect(() => () => source?.paint(NO_ROWS, -1), [source]);

  const show = useCallback(
    async (index: number, wrapped: "first" | "last" | null) => {
      const current = latest.current.result;
      if (current.kind !== "Rows" || !current.rows[index]) return false;
      const { signal } = beginMovement();
      update({ result: { ...current, active: index, wrapped } });
      return reveal(current.rows, index, signal).catch(
        (error: unknown) => (fail(error, signal), false),
      );
    },
    [beginMovement, fail, reveal, update],
  );
  const clear = useCallback(() => {
    lifetime.autoRevealAllowed = false;
    lifetime.computation?.abort();
    lifetime.movement?.abort();
    lifetime.prepared = false;
    source?.paint(NO_ROWS, -1);
    update({ query: "", narrow: null, result: IDLE });
  }, [lifetime, source, update]);
  const controller = useMemo<FindController | null>(() => {
    if (!source) return null;
    const restart = () => {
      lifetime.computation?.abort();
      lifetime.movement?.abort();
      lifetime.autoRevealAllowed = true;
    };
    const option = (name: "matchCase" | "wholeWord" | "narrowed", value: boolean) => {
      if (latest.current[name] === value) return;
      restart();
      update({ [name]: value, result: latest.current.query ? { kind: "Searching" } : IDLE });
    };
    return {
      label: source.label,
      query,
      matchCase,
      wholeWord,
      narrowLabel: source.narrowLabel,
      narrow: session.narrow,
      narrowed,
      result,
      returnable: session.returnable,
      clear,
      setQuery(value) {
        const next = truncatePaneSearchQuery(value);
        if (!next) return clear();
        if (next === latest.current.query) return;
        restart();
        prepare();
        update({ query: next, result: { kind: "Searching" } });
      },
      setMatchCase: (value) => option("matchCase", value),
      setWholeWord: (value) => option("wholeWord", value),
      setNarrowed: (value) => option("narrowed", value),
      activate: (index) => show(index, null),
      step(direction) {
        const current = latest.current.result;
        if (current.kind !== "Rows" || current.rows.length === 0) return;
        const next = current.active + direction;
        const count = current.rows.length;
        void show(
          (next + count) % count,
          next === count ? "first" : next < 0 ? "last" : null,
        );
      },
      retry() {
        restart();
        update({
          attempt: latest.current.attempt + 1,
          result: latest.current.query ? { kind: "Searching" } : IDLE,
        });
      },
      goBack() {
        lifetime.autoRevealAllowed = false;
        lifetime.movement?.abort();
        source.returnToOrigin?.();
        update({ returnable: false });
      },
    };
  }, [clear, lifetime, matchCase, narrowed, prepare, query, result, session.narrow, session.returnable, show, source, update, wholeWord]);

  if (session.defect) throw session.defect.error;
  return controller;
}
