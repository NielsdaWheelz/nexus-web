"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import { useMediaQueryRevision, useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { useChangeStamp } from "@/lib/api/changes";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { lecternSuggestionsResource, librarySuggestionsResource } from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  getSuggestions,
  presentSuggestionItem,
  type Suggestions,
  type SuggestionItem,
  type SuggestionTarget,
} from "@/lib/suggestions";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useMobileChrome } from "@/lib/mobileShell/chrome";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
import { parseMediaId } from "@/lib/lectern/contract";
import { useLectern } from "@/lib/lectern/LecternProvider";
import { usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./SuggestionsSection.module.css";
import addStyles from "./LecternAddControl.module.css";

export type SuggestionsDestination =
  { kind: "Lectern" } | { kind: "Library"; id: string; name: string };

/**
 * Accepted removes the suggestion; Retained leaves it to later query facts.
 * The destination owns unresolved-command recovery independently of this row.
 */
export type SuggestionAccept = (target: SuggestionTarget) => Promise<"Accepted" | "Retained">;

/**
 * Next-read suggestions for one destination. Key it by destination: state
 * belongs to one. Add files the item, removes its row, appends at most one
 * fresh replacement and moves focus to the survivor in the same position; an
 * emptied section hands focus to pane chrome before it hides. Activation
 * refreshes the list.
 */
export default function SuggestionsSection({
  destination,
  paneId,
  isActive,
  accept,
  returnScope,
}: {
  destination: SuggestionsDestination;
  paneId: string;
  isActive: boolean;
  accept: SuggestionAccept;
  returnScope: string;
}) {
  const lectern = destination.kind === "Lectern";
  const { ensureRequests, resource: lecternResource } = useLectern();
  const atCapacity = lectern && lecternResource.status === "ready" && lecternResource.data.atCapacity;
  const load = (signal?: AbortSignal) =>
    getSuggestions(
      lectern
        ? "/api/lectern/suggestions"
        : `/api/libraries/${encodeURIComponent(destination.id)}/suggestions`,
      signal,
    );
  const [version, setVersion] = useState(0);
  const [rows, setRows] = useState<SuggestionItem[] | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const changes = useChangeStamp("Consumption", "Entries");
  const queryRevision = useMediaQueryRevision();
  const factsKey = `${changes}:${queryRevision}`;
  const wasActive = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActive.current) setVersion((value) => value + 1);
    wasActive.current = isActive;
  }, [isActive]);
  const resourceKey = lectern
    ? lecternSuggestionsResource.cacheKey({ refreshVersion: version })
    : librarySuggestionsResource.cacheKey({ id: destination.id, refreshVersion: version });
  const resource = useResource<Suggestions>({
    cacheKey: adding !== null || (!isActive && rows === null) ? null
      : factsKey === "0:0:0" ? resourceKey : `${resourceKey}:facts:${factsKey}`,
    load,
  });

  // Rows follow each fresh read; an Add edits them locally until the next one.
  const [read, setRead] = useState<Suggestions | null>(null);
  if (resource.status === "ready" && resource.data !== read) {
    setRead(resource.data);
    setRows(resource.data.items);
  }
  const summaries = useMediaSummaries(rows?.flatMap((item) =>
    item.target.kind === "Media" ? [item.target.mediaSummary] : []) ?? []);
  const currentRows = rows?.flatMap<SuggestionItem>((item) => {
    if (item.target.kind !== "Media") return [item];
    const mediaSummary = summaries.resolve(item.target.mediaSummary);
    return mediaSummary.kind === "Absent" ? [] : [{ ...item,
      target: { ...item.target, mediaSummary: mediaSummary.value } }];
  }) ?? [];
  const [notice, setNotice] = useState<{
    text: string;
    alert?: boolean;
  } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  if (defect) throw defect.error;

  const sectionId = `suggestions-${useId().replaceAll(":", "")}`;
  const title = lectern ? "Suggestions" : "Suggested for this library";
  const ariaLabel = lectern
    ? "Suggestions"
    : `Suggestions for ${destination.name}`;
  const isMobile = useIsMobileViewport();
  const chrome = useMobileChrome();
  const live = useRef(true);
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  useEffect(() => {
    live.current = true;
    return () => { live.current = false; };
  }, []);
  const focusRef = useRef<string | null | undefined>(undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  // The root always commits: pane return needs it even while the section hides.
  usePaneReturnDescendantReady({
    rootRef,
    ready: rows !== null || resource.status === "error",
  });

  useLayoutEffect(() => {
    const ref = focusRef.current;
    if (ref === undefined) return;
    focusRef.current = undefined;
    const section = document.getElementById(sectionId);
    const row = section?.querySelector<HTMLElement>(
      `[data-collection-row-id="${CSS.escape(ref ?? "")}"] [data-row-focusable]`,
    );
    (row ?? section)?.focus();
  }, [rows, sectionId]);

  async function add(item: SuggestionItem, row: HTMLElement) {
    const current = rows ?? [];
    const index = current.findIndex((candidate) => candidate.target.ref === item.target.ref);
    const ownsFocus = row.contains(document.activeElement);
    setAdding(item.target.ref);
    setNotice(null);
    try {
      if (await accept(item.target) === "Retained") {
        setAdding(null);
        return;
      }
    } catch (error) {
      setAdding(null);
      // An aborted command (its owner went away) and a sign-out end quietly.
      if (isAbortError(error) || handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error))
        return setDefect({ error });
      return setNotice({
        text: lectern ? `couldn’t add to lectern. ${error.message}` : error.message || "Couldn’t add this item.",
        alert: true,
      });
    }
    const survivors = current.filter((candidate) => candidate.target.ref !== item.target.ref);
    let next = survivors;
    try {
      const known = new Set([
        item.target.ref,
        ...survivors.map((r) => r.target.ref),
      ]);
      const fresh = (await load()).items.find((r) => !known.has(r.target.ref));
      if (fresh) next = [...survivors, fresh];
    } catch {
      setNotice({ text: "Added, but couldn’t refill suggestions." });
    }
    if (!live.current) return;
    if (ownsFocus && activeRef.current && next.length === 0) {
      if (isMobile) chrome.focusPaneChrome(paneId);
      else findPaneChromeFocusTarget(paneId)?.focus();
    } else if (ownsFocus) {
      focusRef.current = (next[index] ?? next.at(-1))?.target.ref ?? null;
    }
    setAdding(null);
    setRows(next);
  }

  const failed = resource.status === "error" ? resource : null;
  const hidden = rows === null ? !failed : rows.length === 0;
  const status = failed
    ? {
        text: rows
          ? "Couldn’t refresh suggestions."
          : "Couldn’t load suggestions.",
      }
    : notice;
  return (
    <div ref={rootRef} style={{ display: "contents" }}>
      {hidden ? null : (
        <PaneSection
          className={lectern ? addStyles.collection : undefined}
          id={sectionId}
          aria-label={ariaLabel}
          tabIndex={-1}
          title={title}
          aria-busy={
            adding !== null || resource.status === "loading" || undefined
          }
        >
          <CollectionView
            returnScope={returnScope}
            rows={currentRows.map(presentSuggestionItem)}
            status="ready"
            ariaLabel={ariaLabel}
            surface={false}
            notice={
              <><MediaSummaryNotice error={summaries.error} retry={summaries.retry} />{status ? (
                <div
                  className={status.alert ? styles.alert : styles.quiet}
                  role={status.alert ? "alert" : undefined}
                >
                  <span>{status.text}</span>
                  {failed ? (
                    <Button variant="ghost" size="sm" onClick={failed.retry}>
                      Retry
                    </Button>
                  ) : null}
                </div>
              ) : null}</>
            }
            rowControls={Object.fromEntries(
              currentRows.map((item) => {
                const title = item.target.kind === "Media" ? item.target.mediaSummary.title : item.target.title;
                const request = lectern && item.target.kind === "Media"
                  ? ensureRequests.get(parseMediaId(item.target.mediaSummary.mediaId)) : undefined;
                const busy = request ? request.kind !== "Unconfirmed" : adding !== null;
                const capacityBlocked = atCapacity && request === undefined;
                const checking = request !== undefined && request.kind !== "Sending";
                return [
                  item.target.ref,
                  <Button
                    key={item.target.ref}
                    variant="secondary"
                    size="sm"
                    className={lectern ? addStyles.button : undefined}
                    aria-label={checking ? `check add for ${title}` : `add ${title} to ${lectern ? "lectern" : destination.name}`}
                    disabled={!lectern && busy}
                    loading={!lectern && adding === item.target.ref}
                    aria-disabled={(lectern && (busy || capacityBlocked)) || undefined}
                    aria-busy={(lectern && busy) || undefined}
                    title={capacityBlocked ? "lectern is full; remove an item to add another." : undefined}
                    onClick={(event) => {
                      if (busy || capacityBlocked) return;
                      if (request?.kind === "Unconfirmed") return request.check();
                      const row = event.currentTarget.closest<HTMLElement>(
                        "[data-collection-row-id]",
                      );
                      if (row) void add(item, row);
                    }}
                  >
                    {lectern ? <span className={addStyles.label}>
                      <span className={addStyles.sizer} aria-hidden>{checking ? "check add" : "add to lectern"}</span>
                      <span>{checking ? "check add" : request?.kind === "Sending" ? "adding…" : "add to lectern"}</span>
                    </span> : "Add"}
                  </Button>,
                ];
              }),
            )}
          />
        </PaneSection>
      )}
    </div>
  );
}
