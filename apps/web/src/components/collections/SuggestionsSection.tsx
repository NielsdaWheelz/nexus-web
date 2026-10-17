"use client";

/**
 * Quick reads, Lectern suggestions and a library's suggestions: one read of
 * `{items: SuggestionItemOut[]}` per pane activation (never per progress save). Quick reads always
 * shows its heading and offers each media's shared Lectern add (LecternAddControl); the other
 * two hide while empty. Add files the target, drops its row (unless the destination retains it),
 * appends at most one fresh replacement and keeps focus in place until the next activation.
 */

import { useId, useLayoutEffect, useRef, useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import LecternAddControl from "@/components/collections/LecternAddControl";
import MediaSummaryNotice from "@/components/collections/MediaSummaryNotice";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
  type ApiPath,
} from "@/lib/api/client";
import { useServerValue, useThrowLater } from "@/lib/api/serverState";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { presentMedia } from "@/lib/collections/presenters/media";
import type { CollectionRowView } from "@/lib/collections/types";
import { useRefreshStamp } from "@/lib/consumption/refresh";
import { LECTERN_INTENT_COPY, lecternFull, useLectern, useLecternCommands } from "@/lib/lectern/lectern";
import { useMediaSummaries } from "@/lib/media/MediaSummaryProvider";
import { useMobileChrome } from "@/lib/mobileShell/chrome";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import {
  findPaneChromeFocusTarget,
  findPaneCollectionRowFocusTarget,
} from "@/lib/workspace/paneDom";
import {
  definePaneVisitDataKey,
  usePaneReturnDescendantReady,
} from "@/lib/workspace/paneReturnMemento";
import type { Visit } from "@/lib/api/serverState";
import addStyles from "./LecternAddControl.module.css";
import styles from "./SuggestionsSection.module.css";

type Item = Schema<"SuggestionItemOut">;
export type SuggestionTarget = Item["target"];
/** Accepted drops the row; Retained leaves it (an add the Lectern has not confirmed). */
export type SuggestionAccept = (
  target: SuggestionTarget,
) => Promise<"Accepted" | "Retained">;
const RETURN_SCOPE = {
  QuickReads: "Lectern.QuickReads",
  Lectern: "Lectern.Suggestions",
  Library: "Library.Suggestions",
};
const VISIT = {
  QuickReads: definePaneVisitDataKey<Visit<readonly Item[]>>(
    "Suggestions.QuickReads",
  ),
  Lectern: definePaneVisitDataKey<Visit<readonly Item[]>>(
    "Suggestions.Lectern",
  ),
  Library: definePaneVisitDataKey<Visit<readonly Item[]>>(
    "Suggestions.Library",
  ),
};

/** The uuid half of a target's `<scheme>:<uuid>` ref. */
export const suggestionTargetId = (target: SuggestionTarget) =>
  target.ref.slice(target.ref.indexOf(":") + 1);

function present({ target }: Item): CollectionRowView {
  const resourceRef = assumeCanonicalResourceRef(target.ref);
  const primary = { kind: "link" as const, href: target.href };
  if (target.kind === "Media")
    return presentMedia(target.media_summary, {
      id: target.ref,
      primary,
      resourceRef,
      selected: false,
    });
  return {
    id: target.ref,
    kind: "podcast",
    primary: { ...primary, paneLabelHint: target.title },
    title: { text: target.title },
    contributors: [],
    publicationDate: null,
    context:
      target.subtitle !== null ? { kind: "Text", text: target.subtitle } : null,
    activity: null,
    exceptionalStatus: null,
    resourceRef,
    selected: false,
  };
}

export default function SuggestionsSection(
  props: { isActive: boolean } & (
    | { kind: "QuickReads" }
    | { kind: "Lectern"; accept: SuggestionAccept }
    | {
        kind: "Library";
        library: { id: string; name: string };
        accept: SuggestionAccept;
      }
  ),
) {
  const { kind } = props;
  const path: ApiPath =
    kind === "QuickReads"
      ? "/api/lectern/quick-reads"
      : kind === "Lectern"
        ? "/api/lectern/suggestions"
        : `/api/libraries/${props.library.id}/suggestions`;
  const accept = kind === "QuickReads" ? null : props.accept;
  const title =
    kind === "QuickReads"
      ? "Quick reads"
      : kind === "Lectern"
        ? "Suggestions"
        : "Suggested for this library";
  const label =
    kind === "Library" ? `Suggestions for ${props.library.name}` : title;
  const load = async (signal?: AbortSignal) =>
    (await apiFetch<ApiJson<"/lectern/suggestions", "get">>(path, { signal }))
      .data.items;
  // Nothing loads before the pane is first active: a pane restored in the background stays quiet.
  const [seen, setSeen] = useState(props.isActive);
  if (props.isActive && !seen) setSeen(true);
  const refresh = useRefreshStamp(props.isActive, null);
  const read = useServerValue({
    key: seen ? path : null,
    stale: String(refresh),
    visit: VISIT[kind],
    load,
  });
  const fail = useThrowLater();
  const full = lecternFull(useLectern());
  const { pending } = useLecternCommands();
  const { run } = useActionRuntime();
  // An Add edits the rows in place until the next read.
  const [edit, setEdit] = useState<{
    generation: number;
    items: readonly Item[];
  } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; alert: boolean } | null>(
    null,
  );
  const generation = read.status === "ready" ? read.generation : -1;
  const loaded =
    edit?.generation === generation
      ? edit.items
      : read.status === "ready"
        ? read.data
        : null;
  const summaries = useMediaSummaries(
    (loaded ?? []).flatMap((item) =>
      item.target.kind === "Media" ? [item.target.media_summary] : [],
    ),
  );
  const items = (loaded ?? []).flatMap((item) => {
    if (item.target.kind !== "Media") return [item];
    const summary = summaries.resolve(item.target.media_summary);
    return summary === null
      ? []
      : [{ ...item, target: { ...item.target, media_summary: summary } }];
  });

  const sectionId = `suggestions-${useId().replaceAll(":", "")}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<string | null | undefined>(undefined);
  const paneId = usePaneRuntime()?.paneId ?? "lectern";
  const isMobile = useIsMobileViewport();
  const chrome = useMobileChrome();
  usePaneReturnDescendantReady({ rootRef, ready: read.status !== "loading" });
  useLayoutEffect(() => {
    const ref = focusRef.current;
    if (ref === undefined) return;
    focusRef.current = undefined;
    const section = document.getElementById(sectionId);
    const row = section?.querySelector<HTMLElement>(
      `[data-collection-row-id="${CSS.escape(ref ?? "")}"] [data-row-focusable]`,
    );
    (row ?? section)?.focus();
  }, [items, sectionId]);

  async function add(item: Item, row: HTMLElement) {
    if (accept === null || loaded === null) return;
    setAdding(item.target.ref);
    setNotice(null);
    try {
      if ((await accept(item.target)) === "Accepted") await retire(item, row);
    } catch (error) {
      if (handleUnauthenticatedApiError(error)) return;
      if (!isApiError(error) || isSameSystemApiDefect(error))
        return fail({ error });
      return setNotice({
        text:
          kind === "Lectern"
            ? `couldn’t add to lectern. ${error.message}`
            : error.message || "Couldn’t add this item.",
        alert: true,
      });
    } finally {
      setAdding(null);
    }
  }

  async function retire(item: Item, row: HTMLElement) {
    if (loaded === null) return;
    const index = loaded.findIndex(
      (candidate) => candidate.target.ref === item.target.ref,
    );
    let next = loaded.filter(
      (candidate) => candidate.target.ref !== item.target.ref,
    );
    try {
      const known = new Set(loaded.map((candidate) => candidate.target.ref));
      const fresh = (await load()).find(
        (candidate) => !known.has(candidate.target.ref),
      );
      if (fresh) next = [...next, fresh];
    } catch {
      setNotice({
        text: "Added, but couldn’t refill suggestions.",
        alert: false,
      });
    }
    const ownsFocus = row.contains(document.activeElement);
    if (ownsFocus && next.length === 0) {
      if (isMobile) chrome.focusPaneChrome(paneId);
      else findPaneChromeFocusTarget(paneId)?.focus();
    } else if (ownsFocus) {
      focusRef.current = (next[index] ?? next.at(-1))?.target.ref ?? null;
    }
    setEdit({ generation, items: next });
  }

  const failure =
    read.status === "failed"
      ? read.error
      : read.status === "ready"
        ? read.error
        : null;
  const failed = failure !== null;
  const hidden = accept !== null && !failed && items.length === 0;
  const destination = kind === "Library" ? props.library.name : "Lectern";
  return (
    <div ref={rootRef} style={{ display: "contents" }}>
      {hidden ? null : (
        <PaneSection
          className={kind === "Library" ? undefined : addStyles.collection}
          id={sectionId}
          title={title}
          aria-label={label}
          aria-busy={adding !== null || read.status === "loading" || undefined}
          tabIndex={-1}
        >
          <CollectionView
            returnScope={RETURN_SCOPE[kind]}
            ariaLabel={label}
            surface={false}
            rows={items.map(present)}
            status={
              loaded !== null
                ? "ready"
                : read.status === "failed"
                  ? "error"
                  : "loading"
            }
            notice={
              <>
                {kind === "Library" || !full ? null : (
                  <FeedbackNotice
                    content={{
                      tone: "Neutral",
                      title: "lectern is full",
                      message: "remove an item to add another.",
                    }}
                    announcement="None"
                  />
                )}
                {kind === "QuickReads" && failed && loaded !== null ? (
                  <FeedbackNotice
                    content={{
                      tone: "Danger",
                      title: "couldn’t refresh quick reads",
                      message: "showing the last loaded items.",
                      requestId: failure.requestId,
                    }}
                    announcement="Polite"
                    actions={[{ label: "retry", onClick: read.refetch }]}
                  />
                ) : null}
                <MediaSummaryNotice
                  error={summaries.error}
                  retry={summaries.retry}
                />
                {notice ? (
                  <p
                    className={notice.alert ? styles.alert : styles.quiet}
                    role={notice.alert ? "alert" : undefined}
                  >
                    {notice.text}
                  </p>
                ) : null}
              </>
            }
            error={
              failed ? (
                kind === "QuickReads" ? (
                  <FeedbackNotice
                    content={{
                      tone: "Danger",
                      title: "couldn’t load quick reads",
                      requestId: failure.requestId,
                    }}
                    announcement="Polite"
                    actions={[{ label: "retry", onClick: read.refetch }]}
                  />
                ) : (
                  <FeedbackNotice
                    content={{
                      tone: "Danger",
                      title: loaded
                        ? `Couldn’t refresh ${title.toLowerCase()}.`
                        : `Couldn’t load ${title.toLowerCase()}.`,
                    }}
                    announcement="Polite"
                    actions={[{ label: "Retry", onClick: read.refetch }]}
                  />
                )
              ) : undefined
            }
            empty={<p>No quick reads.</p>}
            rowControls={Object.fromEntries(
              items.map((item) => {
                const ref = item.target.ref;
                const name =
                  item.target.kind === "Media"
                    ? item.target.media_summary.title
                    : item.target.title;
                if (accept === null)
                  return [
                    ref,
                    item.target.kind === "Media" ? (
                      <LecternAddControl
                        key={ref}
                        mediaId={suggestionTargetId(item.target)}
                        title={name}
                        returnFocus={() =>
                          findPaneCollectionRowFocusTarget(paneId, ref)
                        }
                      />
                    ) : null,
                  ];
                if (kind !== "Lectern")
                  return [
                    ref,
                    <Button
                      key={ref}
                      variant="secondary"
                      size="sm"
                      aria-label={`add ${name} to ${destination}`}
                      disabled={adding !== null}
                      loading={adding === ref}
                      onClick={(event) => {
                        const row = event.currentTarget.closest<HTMLElement>(
                          "[data-collection-row-id]",
                        );
                        if (row) void add(item, row);
                      }}
                    >
                      Add
                    </Button>,
                  ];
                // A pending lectern intent owns this control, including removal or placement.
                const request =
                  item.target.kind === "Media"
                    ? pending.get(suggestionTargetId(item.target))
                    : undefined;
                const busy = adding !== null ||
                  (request !== undefined && request.phase !== "Unconfirmed");
                const copy = LECTERN_INTENT_COPY[request?.intent.kind ?? "Ensure"];
                const label = request
                  ? {
                      Sending: `${copy.verb}…`,
                      Checking: "checking…",
                      Unconfirmed: copy.check,
                    }[request.phase]
                  : "add to lectern";
                return [
                  ref,
                  <Button
                    key={ref}
                    variant="secondary"
                    size="sm"
                    className={addStyles.button}
                    aria-label={`${label}: ${name}`}
                    aria-disabled={busy || undefined}
                    aria-busy={busy || undefined}
                    onClick={(event) => {
                      if (busy) return;
                      const row = event.currentTarget.closest<HTMLElement>(
                        "[data-collection-row-id]",
                      );
                      if (!row) return;
                      if (!request) return void add(item, row);
                      run({
                        ref, id: "LecternMembership", label, title: name,
                        confirmation: null, tracked: true,
                        execute: async () => {
                          setAdding(ref);
                          setNotice(null);
                          try {
                            const outcome = await request.check();
                            if (request.intent.kind === "Ensure" && outcome === "Acknowledged")
                              await retire(item, row);
                          } finally {
                            setAdding(null);
                          }
                        },
                      });
                    }}
                  >
                    <span className={addStyles.label}>
                      <span className={addStyles.sizer} aria-hidden>
                        add to lectern
                      </span>
                      <span>
                        {label}
                      </span>
                    </span>
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
