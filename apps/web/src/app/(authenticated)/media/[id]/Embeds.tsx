"use client";

// A recognised document embed as a card in its placeholder: provider and
// state, title and description, and its actions (open the child media, open
// the original, or inspect a failed article's import). Cards sit outside the canonical text.
import { useEffect, useRef, useState } from "react";
import type { DocumentEmbed, TextUnit } from "@/lib/documentReader/model";
import { articleContentLabel } from "@/lib/documentReader/chrome/ArticleContentNotice";
import { usePaneIsVisible, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import type { Reader } from "@/lib/documentReader/DocumentReader";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { apiFetch, isApiError, outcomeUnknown } from "@/lib/api/client";
import { invalidateReads, publishChange, useChangeStamp } from "@/lib/api/changes";
import type { ApiJson } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import { readAcquisitionGuard, type AcquisitionGuard } from "@/lib/libraries/api";
import { addMediaFromUrl } from "@/lib/imports/ingest";
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

export default function EmbedCard({ embed, reader }: { readonly embed: DocumentEmbed; readonly reader: Reader }) {
  const runtime = usePaneRuntime();
  const { display, target } = embed;
  const visible = usePaneIsVisible();
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const retrieval = embed.retrieval;
  useIntervalPoll({ enabled: visible && retrieval !== null && ["queued", "running", "recovering"].includes(retrieval.status), pollIntervalMs: 2000,
    onPoll: () => { if (document.visibilityState === "visible") reader.reload(); } });
  async function retryQuote() {
    if (!embed.media_id || !retrieval || busy) return;
    setBusy(true); setFailure(null);
    try {
      await apiFetch(`/api/media/${embed.media_id}/embeds/${embed.id}/retry`, {
        method: "POST", body: JSON.stringify({ expected_job_id: retrieval.job_id }),
      });
      reader.reload();
    } catch { setFailure(target.capture_id ? "couldn't fetch the full post; captured excerpt kept" : "post not captured"); }
    finally { setBusy(false); }
  }
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
          {retrieval?.status === "failed" ? <span>{target.capture_id ? "couldn’t fetch the full post; captured excerpt kept" : "post not captured"}</span> : null}
          {retrieval?.can_retry ? <button type="button" disabled={busy} onClick={() => void retryQuote()}>retry</button> : null}
          {failure ? <span role="status">{failure}</span> : null}
          {display.actions.filter(action => action.kind !== "retry_quote").map((action) => {
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

/** Save this immutable body without fetching another revision. */
export function PostActions({ post }: { readonly post: NonNullable<TextUnit["xPost"]> }) {
  const [requestId, setRequestId] = useState(() => createRandomId());
  const guard = useRef<AcquisitionGuard | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveUnconfirmed, setSaveUnconfirmed] = useState(false);
  const [threadId, setThreadId] = useState(() => createRandomId());
  const threadGuard = useRef<AcquisitionGuard | null>(null);
  const [threadHref, setThreadHref] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ mediaId: string; generation: number; stamp: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const captureId = post.owner?.capture_id ?? null;
  const stamp = useChangeStamp("Entries");
  const binding = usePaneFreeServerValue({
    key: captureId ? `x-binding:${captureId}` : null, stale: stamp,
    load: async signal => {
      const { data } = await apiFetch<ApiJson<"/x/captures/{capture_id}/reader", "get">>(`/api/x/captures/${captureId}/reader`, { signal });
      return { mediaId: data.units.find(unit => unit.x_post?.owner?.capture_id === captureId && unit.x_post.relation === "primary")?.x_post?.saved_media_id ?? null };
    },
  });
  const currentConflict = conflict?.stamp === stamp ? conflict : null;
  useEffect(() => {
    if (!saveUnconfirmed || binding.status !== "ready" || !binding.fresh || !binding.data.mediaId) return;
    setRequestId(createRandomId()); guard.current = null; setSaveUnconfirmed(false); setError(null);
  }, [saveUnconfirmed, binding]);
  const visible = usePaneIsVisible();
  const archive = usePaneFreeServerValue({
    key: captureId ? `x-archive:${captureId}` : null, stale: "",
    load: async signal => (await apiFetch<ApiJson<"/x/captures/{capture_id}/archive", "get">>(`/api/x/captures/${captureId}/archive`, { signal })).data,
  });
  const work = archive.status === "ready" ? archive.data.retrieval : null;
  useIntervalPoll({ enabled: visible && work !== null && ["queued", "running", "recovering"].includes(work.status), pollIntervalMs: 2000,
    onPoll: () => { if (document.visibilityState === "visible") archive.refetch(); } });
  const assets = archive.status === "ready" ? archive.data.assets : null;
  useEffect(() => {
    if (!captureId || !assets) return;
    let cancelled = false;
    for (const placeholder of document.querySelectorAll<HTMLElement>("[data-nexus-x-capture][data-nexus-x-asset]")) {
      if (placeholder.dataset.nexusXCapture !== captureId) continue;
      const asset = assets.find(item => item.asset_key === placeholder.dataset.nexusXAsset);
      if (!asset?.url) continue;
      const image = new Image();
      image.alt = placeholder.dataset.nexusXAlt ?? "";
      image.onload = () => { if (!cancelled && placeholder.isConnected) placeholder.replaceWith(image); };
      image.src = asset.url;
    }
    return () => { cancelled = true; };
  }, [captureId, assets]);
  if (!captureId) return null;
  async function save() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      guard.current ??= await readAcquisitionGuard([]);
      await apiFetch<ApiJson<"/media/from-x-capture", "post">>("/api/media/from-x-capture", {
        method: "POST", body: JSON.stringify({ id: requestId, capture_id: captureId, ...guard.current }),
      });
      setRequestId(createRandomId()); guard.current = null; setSaveUnconfirmed(false); setConflict(null);
      publishChange("Entries");
    } catch (failure) {
      if (isApiError(failure) && failure.code === "E_X_CAPTURE_DIFFERENT" && typeof failure.details?.media_id === "string" && typeof failure.details.reader_generation === "number") {
        setRequestId(createRandomId()); guard.current = null; setSaveUnconfirmed(false);
        setConflict({ mediaId: failure.details.media_id, generation: failure.details.reader_generation, stamp });
      } else {
        if (isApiError(failure) && !outcomeUnknown(failure)) { setRequestId(createRandomId()); guard.current = null; setSaveUnconfirmed(false); }
        else { setSaveUnconfirmed(true); invalidateReads("Entries"); }
        setError("couldn't save post; captured text was kept");
      }
    } finally { setBusy(false); }
  }
  async function replace() {
    if (!currentConflict || busy) return;
    setBusy(true); setError(null);
    try {
      await apiFetch<ApiJson<"/media/{media_id}/x-capture", "put">>(`/api/media/${currentConflict.mediaId}/x-capture`, {
        method: "PUT", body: JSON.stringify({ capture_id: captureId, expected_reader_generation: currentConflict.generation }),
      });
      setConflict(null); publishChange("Entries");
    } catch { setError("couldn't change saved version; captured text was kept"); }
    finally { setBusy(false); }
  }
  async function saveThread() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      threadGuard.current ??= await readAcquisitionGuard([]);
      const accepted = await addMediaFromUrl({ id: threadId, url: post.source_url, guard: threadGuard.current });
      setThreadHref(accepted.href);
    } catch (failure) {
      if (isApiError(failure) && !outcomeUnknown(failure)) { setThreadId(createRandomId()); threadGuard.current = null; }
      setError("couldn't save thread; captured text was kept");
    } finally { setBusy(false); }
  }
  return <>
    <a href={`/x/captures/${captureId}`}>open post</a>
    {binding.status === "ready" && binding.fresh && binding.data.mediaId ? <a href={`/media/${binding.data.mediaId}`}>open saved post</a>
      : post.capture_kind === "article_excerpt" ? <span>full post required to save</span>
      : currentConflict ? null : binding.status === "failed" || (binding.status === "ready" && !binding.fresh && binding.error) ? <button type="button" onClick={() => void binding.refetch()}>retry saved post status</button>
      : <button type="button" disabled={busy || binding.status !== "ready" || !binding.fresh} onClick={() => void save()}>{busy ? "saving…" : saveUnconfirmed ? "retry save" : "save post"}</button>}
    {currentConflict ? <><a href={`/media/${currentConflict.mediaId}`}>open saved post</a><button type="button" disabled={busy} onClick={() => void replace()}>use this captured version</button></> : null}
    {threadHref ? <a href={threadHref}>open thread</a> : <button type="button" disabled={busy} onClick={() => void saveThread()}>save thread</button>}
    {archive.status === "failed" ? <button type="button" onClick={archive.refetch}>retry image status</button> : null}
    {work?.can_retry ? <button type="button" onClick={() => void apiFetch<ApiJson<"/x/captures/{capture_id}/retry-images", "post">>(`/api/x/captures/${captureId}/retry-images`, {
      method: "POST", body: JSON.stringify({ expected_job_id: work.job_id }),
    }).then(() => archive.refetch()).catch(() => setError("couldn't retry images; captured text was kept"))}>retry missing images</button> : null}
    {error ? <span role="status">{error}</span> : null}
  </>;
}
