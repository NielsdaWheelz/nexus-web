"use client";

// A recognised document embed as a card in its placeholder: provider and
// state, title and description, and its actions (open the child media, open
// the original, or inspect a failed article's import). Cards sit outside the canonical text.
import { useState } from "react";
import type { DocumentEmbed, TextUnit } from "@/lib/documentReader/model";
import { articleContentLabel } from "@/lib/documentReader/chrome/ArticleContentNotice";
import { usePaneRuntime } from "@/lib/panes/paneRuntime";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import { isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import { createRandomId } from "@/lib/createRandomId";
import { addMediaFromUrl, fetchAcceptedSource, type AcceptedIngest } from "@/lib/imports/ingest";
import { fetchImportDetail, recoverMedia } from "@/lib/imports/api";
import { useImports } from "@/lib/imports/ImportsProvider";
import { captureErrorFeedback, importFailureCopy } from "@/lib/imports/copy";
import { encodeImportsUrl } from "@/lib/imports/query";
import { actionFailure } from "@/lib/actions/catalog";
import { hostedSource, readerDestinationHref } from "./hostedReader";
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
  const runtime = usePaneRuntime();
  const { display, target } = embed;
  const article = embed.provider === "x" && embed.kind === "link_preview";
  const thumbnail = safeHref(target.thumbnail_url);
  const title = target.title?.trim() ?? null;
  const description = display.description?.trim() ?? null;
  return (
    <figure
      className={styles.embed}
      data-document-embed-state={display.mode}
      aria-label={description ? `${display.label}: ${description}` : display.label}
    >
      {thumbnail ? (
        // eslint-disable-next-line @next/next/no-img-element -- justify-eslint-override: a provider's own thumbnail url, shown as given
        <img src={thumbnail} alt="" loading="lazy" decoding="async" />
      ) : null}
      <figcaption>
        <span className={styles.kind}>
          {PROVIDER[embed.provider]}
          {target.x_article_content ? ` · ${articleContentLabel(target.x_article_content)}` : null}
          {article || display.mode === null ? null : ` · ${display.mode[0].toUpperCase() + display.mode.slice(1)}`}
        </span>
        <strong>{article ? title ?? display.label : display.label}</strong>
        {article && target.byline ? <p>{target.byline}</p> : null}
        {article ? description ? <p>{description}</p> : null : title || description ? <p>{title || description}</p> : null}
        {!article && title && description && description !== title ? (
          <p>{description}</p>
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
                data-workspace-rich-target={action.kind === "view_import" ? "true" : undefined}
                onClick={action.kind === "view_import" ? (event) => activateTargetLink({
                  event, runtime, target: { href, secondaryActivation: { surfaceId: "import-detail" } },
                }) : undefined}
                onKeyDown={action.kind === "view_import" ? (event) => activateTargetLink({
                  event, runtime, target: { href, secondaryActivation: { surfaceId: "import-detail" } },
                }) : undefined}
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
  const runtime = usePaneRuntime();
  const imports = useImports();
  const [requestId, setRequestId] = useState(() => createRandomId());
  const fail = useThrowLater();
  const [request, setRequest] = useState<AcceptedIngest | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detail = usePaneFreeServerValue({
    key: request?.sourceAttemptId ?? null,
    stale: imports.observation,
    load: async (signal) => {
      const source = await fetchAcceptedSource(request!.sourceAttemptId!, signal);
      return { source, detail: source.settled ? await fetchImportDetail(source.import_ref, signal) : null };
    },
  });
  if (!post.owner) return null;
  const item = detail.status === "ready" ? detail.data.detail?.item : null;
  const saved = item?.can_read ? item.media_id : null;
  const importHref = `/imports?${encodeImportsUrl(item
    ? { selected: item.ref }
    : { view: "InProgress" })}`;
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
    {request ? <a href={importHref} data-workspace-rich-target="true" onClick={(event) => activateTargetLink({
      event, runtime, target: { href: importHref, ...(item ? { secondaryActivation: { surfaceId: "import-detail" } } : {}) },
    })} onKeyDown={(event) => activateTargetLink({
      event, runtime, target: { href: importHref, ...(item ? { secondaryActivation: { surfaceId: "import-detail" } } : {}) },
    })}>{item ? "view import" : "view imports"}</a> : null}
    {saved ? <SavedThreadLink mediaId={saved} postMediaId={post.owner.media_id} /> : null}
    {error || failure ? <span role="status">{error ?? (failure ? importFailureCopy(failure).title : null)}</span> : null}
    {detail.status === "failed" ? <button type="button" onClick={detail.refetch}>retry import status</button> : null}
  </>;
}

/** Bind the saved thread's exact publication before exposing a native link. */
function SavedThreadLink({ mediaId, postMediaId }: { readonly mediaId: string; readonly postMediaId: string }) {
  const source = usePaneFreeServerValue({
    key: `saved-thread-reader:${mediaId}`,
    stale: "",
    load: (signal) => hostedSource(mediaId).load(signal),
  });
  const doc = source.status === "ready" ? source.data : null;
  const unit = doc?.kind === "text" ? doc.units.find((unit) => unit.xPost?.owner?.media_id === postMediaId) : null;
  const href = doc && unit ? readerDestinationHref(mediaId, { source_identity: doc.identity, target: { kind: "point", point: { kind: "text", unit: unit.id, offset: 0 } } }) : null;
  if (href) return <a href={href}>open thread</a>;
  const unavailable = source.status === "ready" || source.status === "failed";
  return <>
    <span role="status">{unavailable ? "post unavailable in saved thread" : "locating saved post…"}</span>
    {unavailable ? <button type="button" onClick={source.refetch}>retry saved post</button> : null}
  </>;
}
