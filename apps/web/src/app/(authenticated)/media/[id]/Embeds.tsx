"use client";
import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";

// A recognised document embed as a card in its placeholder: provider and
// state, title and description, and its actions (open the child media, open
// the original, or inspect a failed article's import). Cards sit outside the canonical text.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { sentence } from "@/components/feedback/stage";
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
import { VerbControl } from "@/components/feedback/Fact";
import Button from "@/components/ui/Button";
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

/** One immutable request, keyed by its caller. Its callbacks retire with the command; a
 * canonical refresh reads only, and a refused resend preserves earlier uncertainty. */
function CaptureRetry({ request, label, fact, unsure, busy, setBusy, refresh, accepted }: {
  readonly request: { readonly path: `/api/${string}`; readonly method: "POST" | "PUT"; readonly body: string };
  readonly label: string;
  readonly fact: string;
  readonly unsure: string;
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly refresh: () => void;
  readonly accepted?: () => void;
}) {
  const id = useId();
  const live = useRef(true);
  const sending = useRef(false);
  const [attempt, setAttempt] = useState<number | null>(null);
  const { fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  async function run() {
    if (!live.current || busy || sending.current) return;
    sending.current = true;
    setBusy(true);
    try { await apiFetch(request.path, { method: request.method, body: request.body }); }
    catch (error) {
      if (!live.current) return;
      if (outcomeUnknown(error)) setAttempt(value => (value ?? 0) + 1);
      else fail(error, fact, retry);
      return;
    } finally {
      sending.current = false;
      setBusy(false);
      if (live.current) refresh();
    }
    if (!live.current) return;
    setAttempt(null);
    accepted?.();
  }
  const retry = { label: "retry", commandKey: id, run: () => void run(), busy };
  const feedback = resendFeedback({ line: { fact: unsure, reason: UNKNOWN_OUTCOME_REASON }, resend: retry });
  return <>
    {attempt === null ? <Button disabled={busy} aria-busy={busy || undefined} onClick={() => void run()}>{label}</Button>
      : feedback.verbs === null ? null : <><span id={`${id}:context`} className="sr-only">{sentence(feedback.line)}</span><VerbControl verb={feedback.verbs[0]} contextId={`${id}:context`} /></>}
    {attempt === null ? null : <Hold id={id} attempt={attempt} {...feedback} />}
  </>;
}

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
  const [busy, setBusy] = useState(false);
  const retrieval = embed.retrieval;
  useIntervalPoll({ enabled: visible && retrieval !== null && ["queued", "running", "recovering"].includes(retrieval.status), pollIntervalMs: 2000,
    onPoll: () => { if (document.visibilityState === "visible") reader.reload(); } });
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
          {retrieval?.status === "failed" ? <span>{target.capture_id ? "couldn’t fetch the full post. the captured excerpt is kept." : "this post wasn’t captured."}</span> : null}
          {retrieval?.can_retry && embed.media_id ? <CaptureRetry key={JSON.stringify([embed.media_id, embed.id, retrieval.job_id])}
            request={{ path: `/api/media/${embed.media_id}/embeds/${embed.id}/retry`, method: "POST", body: JSON.stringify({ expected_job_id: retrieval.job_id }) }}
            label="retry" fact="couldn’t fetch the full post." unsure="not sure the full post started downloading."
            busy={busy} setBusy={setBusy} refresh={reader.reload} /> : null}
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
  const live = useRef(true);
  const requestOwner = useRef(requestId);
  requestOwner.current = requestId;
  useLayoutEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [busy, setBusy] = useState(false);
  const [saveUnconfirmed, setSaveUnconfirmed] = useState<number | null>(null);
  const [threadUnconfirmed, setThreadUnconfirmed] = useState<number | null>(null);
  const [threadId, setThreadId] = useState(() => createRandomId());
  const threadGuard = useRef<AcquisitionGuard | null>(null);
  const threadOwner = useRef(threadId);
  threadOwner.current = threadId;
  const [threadHref, setThreadHref] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ mediaId: string; generation: number } | null>(null);
  const { fail } = useOutcome();
  const fullOnlyId = useId();
  const saveContext = useId();
  const threadContext = useId();
  const resendFeedback = useResendFeedback();
  const captureId = post.owner?.capture_id ?? null;
  const stamp = useChangeStamp("Entries");
  const binding = usePaneFreeServerValue({
    key: captureId ? `x-binding:${captureId}` : null, stale: stamp,
    load: async signal => {
      const { data } = await apiFetch<ApiJson<"/x/captures/{capture_id}/reader", "get">>(`/api/x/captures/${captureId}/reader`, { signal });
      return { mediaId: data.units.find(unit => unit.x_post?.owner?.capture_id === captureId && unit.x_post.relation === "primary")?.x_post?.saved_media_id ?? null };
    },
  });
  useEffect(() => {
    if (binding.status !== "ready" || !binding.fresh || !binding.data.mediaId) return;
    if (saveUnconfirmed) { setRequestId(createRandomId()); guard.current = null; setSaveUnconfirmed(null); }
    if (conflict?.mediaId === binding.data.mediaId) setConflict(null);
  }, [saveUnconfirmed, binding, conflict]);
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
    if (busy || !live.current || requestOwner.current !== requestId) return;
    setBusy(true);
    try { guard.current ??= await readAcquisitionGuard([]); }
    catch (error) { if (live.current) { fail(error, "couldn’t save the post."); setBusy(false); } return; }
    if (!live.current || requestOwner.current !== requestId) { setBusy(false); return; }
    try {
      await apiFetch<ApiJson<"/media/from-x-capture", "post">>("/api/media/from-x-capture", {
        method: "POST", body: JSON.stringify({ id: requestId, capture_id: captureId, ...guard.current }),
      });
      if (!live.current || requestOwner.current !== requestId) return;
      setRequestId(createRandomId()); guard.current = null; setSaveUnconfirmed(null); setConflict(null);
      publishChange("Entries");
    } catch (failure) {
      if (!live.current || requestOwner.current !== requestId) return;
      if (isApiError(failure) && failure.code === "E_X_CAPTURE_DIFFERENT" && typeof failure.details?.media_id === "string" && typeof failure.details.reader_generation === "number") {
        setRequestId(createRandomId()); guard.current = null; setSaveUnconfirmed(null);
        setConflict({ mediaId: failure.details.media_id, generation: failure.details.reader_generation });
      } else if (outcomeUnknown(failure)) {
        // the kept request id makes the resend the same save.
        setSaveUnconfirmed(attempt => (attempt ?? 0) + 1); invalidateReads("Entries");
      } else {
        if (!saveUnconfirmed) { setRequestId(createRandomId()); guard.current = null; }
        fail(failure, "couldn’t save the post.");
      }
    } finally { setBusy(false); }
  }
  async function saveThread() {
    if (busy || !live.current || threadOwner.current !== threadId) return;
    setBusy(true);
    try { threadGuard.current ??= await readAcquisitionGuard([]); }
    catch (error) { if (live.current) { fail(error, "couldn’t save the thread."); setBusy(false); } return; }
    if (!live.current || threadOwner.current !== threadId) { setBusy(false); return; }
    try {
      const accepted = await addMediaFromUrl({ id: threadId, url: post.source_url, guard: threadGuard.current });
      if (!live.current || threadOwner.current !== threadId) return;
      setThreadHref(accepted.href);
      setThreadUnconfirmed(null); setThreadId(createRandomId()); threadGuard.current = null;
    } catch (failure) {
      if (!live.current || threadOwner.current !== threadId) return;
      // only a definite refusal renews the id; an unknown outcome resends the same save.
      if (outcomeUnknown(failure)) setThreadUnconfirmed(attempt => (attempt ?? 0) + 1);
      else { if (!threadUnconfirmed) { setThreadId(createRandomId()); threadGuard.current = null; } fail(failure, "couldn’t save the thread."); }
    } finally { setBusy(false); }
  }
  const saveFeedback = resendFeedback({ line: { fact: "not sure the post saved.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry post", commandKey: `RetryPost:${requestId}`, run: () => void save(), busy } });
  const threadFeedback = resendFeedback({ line: { fact: "not sure the thread saved.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry thread", commandKey: `RetryThread:${threadId}`, run: () => void saveThread(), busy } });
  return <>
    <a href={`/x/captures/${captureId}`}>open post</a>
    {binding.status === "ready" && binding.fresh && binding.data.mediaId ? <a href={`/media/${binding.data.mediaId}`}>open saved post</a>
      : post.capture_kind === "article_excerpt" ? <><Button aria-disabled="true" aria-describedby={fullOnlyId}>save post</Button><span id={fullOnlyId}>only the full post can be saved.</span></>
      : conflict ? null : binding.status === "failed" || (binding.status === "ready" && !binding.fresh && binding.error) ? <Button onClick={() => void binding.refetch()}>check saved post</Button>
      : saveUnconfirmed ? saveFeedback.verbs === null ? null : <VerbControl verb={saveFeedback.verbs[0]} contextId={saveContext} />
      : <Button disabled={busy || binding.status !== "ready" || !binding.fresh} aria-busy={busy || undefined} onClick={() => void save()}>save post</Button>}
    {conflict ? <><a href={`/media/${conflict.mediaId}`}>open saved post</a>
      <CaptureRetry key={JSON.stringify([conflict.mediaId, captureId, conflict.generation])}
        request={{ path: `/api/media/${conflict.mediaId}/x-capture`, method: "PUT", body: JSON.stringify({ capture_id: captureId, expected_reader_generation: conflict.generation }) }}
        label="use this captured version" fact="couldn’t replace the saved post." unsure="not sure the saved post changed."
        busy={busy} setBusy={setBusy} refresh={() => invalidateReads("Entries")} accepted={() => { setConflict(null); publishChange("Entries"); }} />
    </> : null}
    {threadHref ? <a href={threadHref}>open thread</a> : threadUnconfirmed ? threadFeedback.verbs === null ? null : <VerbControl verb={threadFeedback.verbs[0]} contextId={threadContext} /> : <Button disabled={busy} aria-busy={busy || undefined} onClick={() => void saveThread()}>save thread</Button>}
    {archive.status === "failed" ? <Button onClick={archive.refetch}>check images</Button> : null}
    {work?.can_retry ? <CaptureRetry key={JSON.stringify([captureId, work.job_id])}
      request={{ path: `/api/x/captures/${captureId}/retry-images`, method: "POST", body: JSON.stringify({ expected_job_id: work.job_id }) }}
      label="retry missing images" fact="couldn’t fetch the missing images." unsure="not sure the images started downloading."
      busy={busy} setBusy={setBusy} refresh={archive.revalidate} /> : null}
    {saveUnconfirmed ? <><span id={saveContext} className="sr-only">{sentence(saveFeedback.line)}</span><Hold id={`x-post-save:${requestId}`} attempt={saveUnconfirmed ?? 0} {...saveFeedback} /></> : null}
    {threadUnconfirmed ? <><span id={threadContext} className="sr-only">{sentence(threadFeedback.line)}</span><Hold id={`x-thread-save:${threadId}`} attempt={threadUnconfirmed ?? 0} {...threadFeedback} /></> : null}
  </>;
}
