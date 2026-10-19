"use client";

// A recognised document embed as a card in its placeholder: provider and
// state, title and description, and its actions (open the child media, open
// the original). Cards sit outside the canonical text.
import { useState } from "react";
import type { DocumentEmbed, TextUnit } from "@/lib/documentReader/model";
import { usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { createRandomId } from "@/lib/createRandomId";
import { addMediaFromUrl, type AcceptedIngest } from "@/lib/imports/ingest";
import { fetchImportDetail, recoverMedia } from "@/lib/imports/api";
import { useImports } from "@/lib/imports/ImportsProvider";
import { captureErrorFeedback, importFailureCopy } from "@/lib/imports/copy";
import { actionFailure } from "@/lib/actions/catalog";
import styles from "./media.module.css";

const PROVIDER: Record<DocumentEmbed["provider"], string> = {
  youtube: "YouTube",
  x: "X",
  substack: "Substack",
  vimeo: "Vimeo",
  spotify: "Spotify",
  generic: "Embedded content",
  unknown: "Unknown provider",
};

/** An http(s) url or an in-app path; anything else is no link. */
function safeHref(value: string | null | undefined): string | null {
  const href = value?.trim();
  if (!href) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  try {
    return ["http:", "https:"].includes(new URL(href).protocol) ? href : null;
  } catch {
    return null;
  }
}

export default function EmbedCard({ embed }: { readonly embed: DocumentEmbed }) {
  const { display, target } = embed;
  const thumbnail = safeHref(target.thumbnail_url);
  const title = target.title?.trim();
  return (
    <figure
      className={styles.embed}
      data-document-embed-state={display.mode}
      aria-label={`${display.label}: ${display.description}`}
    >
      {thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element -- justify-eslint-override: a provider's own thumbnail url, shown as given
        <img src={thumbnail} alt="" loading="lazy" decoding="async" />
      ) : null}
      <figcaption>
        <span className={styles.kind}>
          {PROVIDER[embed.provider]} ·{" "}
          {display.mode[0].toUpperCase() + display.mode.slice(1)}
        </span>
        <strong>{display.label}</strong>
        <p>{title || display.description}</p>
        {title && display.description.trim() && display.description.trim() !== title ? (
          <p>{display.description}</p>
        ) : null}
        <span className={styles.embedActions}>
          {display.actions.map((action) => {
            const href =
              safeHref(action.href) ??
              (action.kind === "open_child_media" && target.media_id
                ? `/media/${target.media_id}`
                : action.kind === "open_original"
                  ? (safeHref(embed.canonical_url.value) ?? safeHref(embed.source_url.value))
                  : null);
            const external = href?.startsWith("http");
            return action.disabled || !href ? (
              <span key={action.kind} aria-disabled="true">
                {action.label}
              </span>
            ) : (
              <a
                key={action.kind}
                href={href}
                {...(external ? { target: "_blank", rel: "noreferrer" } : {})}
              >
                {action.label}
              </a>
            );
          })}
        </span>
      </figcaption>
    </figure>
  );
}

/** Saving acquires the author's thread; opening the captured post never acquires source data. */
export function PostActions({ post }: { readonly post: NonNullable<TextUnit["xPost"]> }) {
  const imports = useImports();
  const [requestId, setRequestId] = useState(() => createRandomId());
  const fail = useThrowLater();
  const [request, setRequest] = useState<AcceptedIngest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detail = usePaneFreeServerValue({
    key: request?.importRef ?? null,
    stale: imports.observation,
    load: (signal) => fetchImportDetail(request!.importRef, signal),
  });
  if (!post.owner) return null;
  const item = detail.status === "ready" ? detail.data.item : null;
  const saved = item?.can_read && item.media_id ? item.media_id : request?.processing === "ready" ? request.mediaId : null;
  const failure = item?.obligations.source?.failure_code;
  const offer = item?.obligations.source?.recovery;
  const recovery = offer?.kind === "RetrySource" || offer?.kind === "RepairSource" ? offer : null;
  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (request) {
        if (!recovery || !item?.media_id) return;
        await recoverMedia(item.media_id, recovery);
        detail.refetch();
      } else setRequest(await addMediaFromUrl({ id: requestId, url: post.source_url, libraryIds: [] }));
    } catch (error) {
      if (isApiError(error) && !["E_NETWORK", "E_UPSTREAM", "E_UPSTREAM_TIMEOUT"].includes(error.code)) {
        if (!request) setRequestId(createRandomId());
        else detail.refetch();
      }
      try {
        const feedback = request && recovery && isApiError(error) && !isSameSystemApiDefect(error)
          ? actionFailure(recovery.kind, "retry saving thread", error)
          : captureErrorFeedback(error, "SaveSource");
        setError(feedback.message ?? feedback.title);
      } catch (defect) { fail({ error: defect }); }
    } finally { setBusy(false); }
  }
  return <>
    <a href={`/media/${post.owner.media_id}`}>open post</a>
    {request === null || recovery ? <button type="button" onClick={() => void save()} disabled={busy}>
      {busy ? "saving thread…" : request ? "retry saving thread" : "save thread"}
    </button> : !saved && !failure ? <span role="status">saving thread…</span> : null}
    {request && failure ? <a href={`/imports?selected=${encodeURIComponent(request.importRef)}`}>view import</a> : null}
    {saved ? <a href={`/media/${saved}?x_post=${post.owner.media_id}`}>open thread</a> : null}
    {error || failure ? <span role="status">{error ?? (failure ? importFailureCopy(failure).title : null)}</span> : null}
    {detail.status === "failed" ? <button type="button" onClick={detail.refetch}>retry import status</button> : null}
  </>;
}
