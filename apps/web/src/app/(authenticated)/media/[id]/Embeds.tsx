"use client";
import { TRANSPORT_LINES, transportOf, UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";

// A recognised document embed as a card in its placeholder: provider and
// state, title and description, and its actions (open the child media, open
// the original, or inspect a failed article's import). Cards sit outside the canonical text.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { sentence, useActiveRegion, useTransportVerbs } from "@/components/feedback/stage";
import type { DocumentEmbed, TextUnit } from "@/lib/documentReader/model";
import { articleContentLabel } from "@/lib/documentReader/chrome/ArticleContentNotice";
import { usePaneIsVisible, usePaneRuntime } from "@/lib/panes/paneRuntime";
import { usePaneFreeServerValue } from "@/lib/api/serverState";
import { useIntervalPoll } from "@/lib/useIntervalPoll";
import type { Reader } from "@/lib/documentReader/DocumentReader";
import { activateTargetLink } from "@/lib/panes/targetLinkActivation";
import { apiFetch, outcomeUnknown } from "@/lib/api/client";
import type { ApiJson } from "@/lib/api/wire";
import { createRandomId } from "@/lib/createRandomId";
import { readAcquisitionGuard } from "@/lib/libraries/api";
import { encodeImportsUrl } from "@/lib/imports/query";
import { importFailureCopy, obligationStatusLine } from "@/lib/imports/copy";
import { useMediaAdmissions } from "@/lib/media/admissions";
import type { PostSaveStates } from "@/lib/media/xPostSaves";
import { Fact, Failed, useFocusReturn, VerbControl } from "@/components/feedback/Fact";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
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
function CaptureRetry({ request, label, fact, unsure, busy, setBusy, refresh }: {
  readonly request: { readonly path: `/api/${string}`; readonly method: "POST"; readonly body: string };
  readonly label: string;
  readonly fact: string;
  readonly unsure: string;
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly refresh: () => void;
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
          {retrieval?.status === "failed" ? <span>couldn’t retrieve the full post during this import.</span> : null}
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

/** The host's one saved-state read fails once, outside the canonical post text. */
export function PostSaveReadFailure({ state }: { readonly state: PostSaveStates }) {
  const verbsFor = useTransportVerbs();
  const speak = useActiveRegion();
  const error = state.status === "loading" ? null : state.error;
  if (error === null) return null;
  const transport = transportOf(error);
  const retry = { run: state.refetch, busy: state.status === "failed" ? state.retrying : state.status === "ready" && state.refreshing };
  if (transport === "Offline" || transport === "SignIn" || transport === "Update")
    return <Failed error={error} noun="saved post details" retry={retry} />;
  return <Fact line={TRANSPORT_LINES[transport].command("couldn’t check the saved post.")} speak={speak}
    verbs={verbsFor(transport, { retry: { ...retry, label: "retry", commandKey: "CheckSavedPosts" } }) ?? undefined} />;
}

/** Save state belongs to the hosted document; live submissions belong to the account. */
export function PostActions({ post, hostMediaId, state }: {
  readonly post: NonNullable<TextUnit["xPost"]>;
  readonly hostMediaId: string | null;
  readonly state: PostSaveStates;
}) {
  const captureId = post.owner?.capture_id ?? null;
  if (captureId === null) return null;
  return <><PostSaveAction post={post} captureId={captureId} hostMediaId={hostMediaId} state={state} />
    <PostArchive captureId={captureId} /></>;
}

function PostSaveAction({ post, captureId, hostMediaId, state }: {
  readonly post: NonNullable<TextUnit["xPost"]>;
  readonly captureId: string;
  readonly hostMediaId: string | null;
  readonly state: PostSaveStates;
}) {
  const admissions = useMediaAdmissions();
  const pending = admissions.pending("XPostSave", captureId);
  const [preparing, setPreparing] = useState(false);
  const preparingNow = useRef(false);
  const { fail, say } = useOutcome();
  const speak = useActiveRegion();
  const runtime = usePaneRuntime();
  const item = state.status === "ready" ? state.data.get(captureId) : undefined;
  const savedMediaId = item && item.kind !== "unavailable" ? item.saved_media_id : null;
  const acquisition = item?.kind === "resolved" ? item.acquisition : null;
  const fresh = state.status === "ready" && state.fresh && state.error === null;
  const busy = preparing || pending?.kind === "sending";
  const self = post.relation === "primary" && savedMediaId === hostMediaId;
  async function save() {
    if (preparingNow.current || pending !== null || !fresh || item?.kind !== "resolved" || savedMediaId !== null || acquisition !== null) return;
    preparingNow.current = true;
    setPreparing(true);
    try {
      const guard = await readAcquisitionGuard([]);
      const result = await admissions.admit({ kind: "XPostSave",
        request: { id: createRandomId(), capture_id: captureId, ...guard } });
      if (result.kind === "LocalFailure") {
        if (result.error !== null) fail(result.error, result.line.fact);
        else say(result.line, result.verbs ?? undefined);
      }
    } catch (error) { fail(error, "couldn’t save the post."); }
    finally { preparingNow.current = false; setPreparing(false); }
  }
  const importHref = acquisition === null ? null : `/imports?${encodeImportsUrl({ selected: `media:${acquisition.media_id}` })}`;
  const sourceFailure = acquisition?.obligation.classification === "NeedsAttention" && acquisition.obligation.failure_code !== null
    ? importFailureCopy(acquisition.obligation.failure_code) : null;
  return <>
    {savedMediaId !== null ? self ? null : <ButtonLink href={`/media/${savedMediaId}?post_revision=${post.source_revision_id}`}>open saved post</ButtonLink>
      : item?.kind === "unavailable" || item?.kind === "conflict" ? null
      : acquisition !== null ? acquisition.obligation.classification === "Active" ? <span>importing…</span> : null
      : <PostSaveButton disabled={!fresh || item === undefined || pending !== null || busy} busy={busy} save={() => void save()} />}
    {item?.kind === "unavailable" ? <div data-post-feedback=""><Fact line={{ fact: "this copy is no longer available." }} /></div> : null}
    {item?.kind === "conflict" ? <div data-post-feedback=""><Fact line={{ fact: "this post has conflicting saves." }} /></div> : null}
    {acquisition !== null && importHref !== null ? <div data-post-feedback=""><Fact speak={speak}
      line={sourceFailure === null ? { fact: `${obligationStatusLine(acquisition.obligation)}.` }
        : { fact: sourceFailure.title, reason: sourceFailure.explanation ?? undefined }}
      verbs={[{ label: "view import", href: importHref, onActivate: event => activateTargetLink({
        event, runtime, target: { href: importHref, secondaryActivation: { surfaceId: "import-detail" } },
      }) }]} /></div> : null}
  </>;
}

/** When saving replaces its control, return owned focus to the reader landmark. */
function PostSaveButton({ disabled, busy, save }: { readonly disabled: boolean; readonly busy: boolean; readonly save: () => void }) {
  const control = useRef<HTMLButtonElement>(null);
  useFocusReturn(control, home => home);
  return <Button ref={control} aria-disabled={disabled || undefined} aria-busy={busy || undefined} onClick={save}>save post</Button>;
}

/** Archive hydration and missing-image recovery are independent of saving a post. */
function PostArchive({ captureId }: { readonly captureId: string }) {
  const visible = usePaneIsVisible();
  const [busy, setBusy] = useState(false);
  const archive = usePaneFreeServerValue({
    key: `x-archive:${captureId}`, stale: "",
    load: async signal => (await apiFetch<ApiJson<"/x/captures/{capture_id}/archive", "get">>(`/api/x/captures/${captureId}/archive`, { signal })).data,
  });
  const work = archive.status === "ready" ? archive.data.retrieval : null;
  useIntervalPoll({ enabled: visible && work !== null && ["queued", "running", "recovering"].includes(work.status), pollIntervalMs: 2000,
    onPoll: () => { if (document.visibilityState === "visible") archive.refetch(); } });
  const assets = archive.status === "ready" ? archive.data.assets : null;
  useEffect(() => {
    if (assets === null) return;
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
  const error = archive.status === "loading" ? null : archive.error;
  return <>
    {error !== null ? <div data-post-feedback=""><Failed error={error} noun="post images"
      retry={{ run: archive.refetch, busy: archive.status === "failed" ? archive.retrying : archive.status === "ready" && archive.refreshing }} /></div> : null}
    {work?.can_retry ? <div data-post-feedback=""><Fact line={{ fact: "some post images are missing." }} />
      <CaptureRetry key={JSON.stringify([captureId, work.job_id])}
        request={{ path: `/api/x/captures/${captureId}/retry-images`, method: "POST", body: JSON.stringify({ expected_job_id: work.job_id }) }}
        label="retry missing images" fact="couldn’t fetch the missing images." unsure="not sure the images started downloading."
        busy={busy} setBusy={setBusy} refresh={archive.revalidate} /></div> : null}
  </>;
}
