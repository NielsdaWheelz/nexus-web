"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { lecternSlateResource, librarySlateResource } from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { isAbortError } from "@/lib/errors";
import {
  getSlate,
  presentSlateItem,
  type Slate,
  type SlateItem,
  type SlateTarget,
} from "@/lib/resonance";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { usePaneChromeFocusReturn } from "@/lib/workspace/mobileChrome";
import { findPaneChromeFocusTarget } from "@/lib/workspace/paneDom";
import { usePaneReturnDescendantReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./ReadingSlateSection.module.css";

export type SlateDestination =
  { kind: "Lectern" } | { kind: "Library"; id: string; name: string };

/**
 * Files the target into the destination. Resolves once it is there; rejects
 * with the reason it is not. A destination that owns its own unknown-outcome
 * recovery (the Lectern) keeps the promise pending until that settles.
 */
export type SlateAccept = (target: SlateTarget) => Promise<void>;

/**
 * Next-read suggestions for one destination. Key it by destination: state
 * belongs to one. Add files the item, removes its row, appends at most one
 * fresh replacement and moves focus to the survivor in the same position; an
 * emptied section hands focus to pane chrome before it hides. Activation
 * refreshes the list.
 */
export default function ReadingSlateSection({
  destination,
  paneId,
  isActive,
  accept,
  returnScope,
}: {
  destination: SlateDestination;
  paneId: string;
  isActive: boolean;
  accept: SlateAccept;
  returnScope: string;
}) {
  const lectern = destination.kind === "Lectern";
  const load = (signal?: AbortSignal) =>
    getSlate(
      lectern
        ? "/api/lectern/slate"
        : `/api/libraries/${encodeURIComponent(destination.id)}/slate`,
      signal,
    );
  const [version, setVersion] = useState(0);
  const wasActive = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActive.current) setVersion((value) => value + 1);
    wasActive.current = isActive;
  }, [isActive]);
  const resource = useResource<Slate>({
    cacheKey: !isActive
      ? null
      : lectern
        ? lecternSlateResource.cacheKey({ refreshVersion: version })
        : librarySlateResource.cacheKey({
            id: destination.id,
            refreshVersion: version,
          }),
    load,
  });

  // Rows follow each fresh read; an Add edits them locally until the next one.
  const [rows, setRows] = useState<SlateItem[] | null>(null);
  const [read, setRead] = useState<Slate | null>(null);
  if (resource.status === "ready" && resource.data !== read) {
    setRead(resource.data);
    setRows(resource.data.items);
  }
  const [adding, setAdding] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    text: string;
    alert?: boolean;
  } | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  if (defect) throw defect.error;

  const sectionId = `reading-slate-${useId().replaceAll(":", "")}`;
  const title = lectern ? "At hand" : "Suggested for this library";
  const ariaLabel = lectern
    ? "At hand suggestions"
    : `Suggestions for ${destination.name}`;
  const isMobile = useIsMobileViewport();
  const { focus: focusPaneChrome } = usePaneChromeFocusReturn();
  const live = useRef(true);
  const activeRef = useRef(isActive);
  activeRef.current = isActive;
  useEffect(() => () => void (live.current = false), []);
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

  async function add(item: SlateItem, row: HTMLElement) {
    const current = rows ?? [];
    const index = current.indexOf(item);
    const ownsFocus = row.contains(document.activeElement);
    setAdding(item.target.ref);
    setNotice(null);
    try {
      await accept(item.target);
    } catch (error) {
      setAdding(null);
      // An aborted command (its owner went away) and a sign-out end quietly.
      if (isAbortError(error) || handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error))
        return setDefect({ error });
      return setNotice({
        text: error.message || "Couldn’t add this item.",
        alert: true,
      });
    }
    const survivors = current.filter((candidate) => candidate !== item);
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
      if (isMobile) await focusPaneChrome(paneId);
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
            rows={(rows ?? []).map(presentSlateItem)}
            status="ready"
            ariaLabel={ariaLabel}
            surface={false}
            notice={
              status ? (
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
              ) : null
            }
            rowControls={Object.fromEntries(
              (rows ?? []).map((item) => [
                item.target.ref,
                <Button
                  key={item.target.ref}
                  variant="secondary"
                  size="sm"
                  aria-label={`Add ${item.target.kind === "Media" ? item.target.mediaSummary.title : item.target.title} to ${lectern ? "Lectern" : destination.name}`}
                  disabled={adding !== null}
                  loading={adding === item.target.ref}
                  onClick={(event) => {
                    const row = event.currentTarget.closest<HTMLElement>(
                      "[data-collection-row-id]",
                    );
                    if (row) void add(item, row);
                  }}
                >
                  {lectern ? "Add to Lectern" : "Add"}
                </Button>,
              ]),
            )}
          />
        </PaneSection>
      )}
    </div>
  );
}
