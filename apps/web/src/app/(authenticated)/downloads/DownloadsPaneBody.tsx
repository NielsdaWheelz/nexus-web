"use client";

// Device-owned downloads, independent of catalog coverage and remote admission.
import { useEffect, useRef, useState } from "react";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import { useWorkGuard } from "@/lib/unsavedWork";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { localCall, localContentAvailable, localMutation, useLocalContent, type FailureReason, type LocalItem } from "@/lib/offline/localContent";
import { useListening } from "@/lib/consumption/listening";
import { retryNativeListening } from "@/lib/player/nativeEngine";
import { usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { formatByteCount } from "@/lib/text/formatByteCount";
import styles from "./downloads.module.css";

const FAILURE: Record<FailureReason, string> = {
  AuthorizationRequired: "sign in required for download",
  SourceUnavailable: "original no longer available",
  Changed: "source changed · remove and download again",
  Storage: "couldn’t save download · check device storage", Network: "network interrupted", Server: "server unavailable",
  Invalid: "downloaded content is invalid", Stopped: "stopped by android", Scheduler: "android couldn’t schedule this download · retry", NeedsDownload: "download again",
};
function status(item: LocalItem): string {
  switch (item.state) {
    case "Queued": return item.attempts > 0 ? "queued · retrying after interruption" : "queued";
    case "Downloading": return item.total === null ? `${formatByteCount(item.received)} received`
      : `${formatByteCount(item.received)} of ${formatByteCount(item.total)}`;
    case "Ready": return `downloaded · ${formatByteCount(item.size_bytes)}`;
    case "Removing": return item.kind === "podcast_episode" ? "removal pending · episode still open" : "removal pending · copy still open";
    case "Failed": return item.failure === null ? "download failed" : FAILURE[item.failure];
  }
}
function extras(item: LocalItem): string | null {
  const transcript = item.extras?.transcript;
  if (transcript === undefined) return null;
  if (transcript.kind === "Absent") return "no published transcript";
  if (transcript.kind === "Pending") return "transcript download pending";
  if (transcript.kind === "Failed") return transcript.reason === "Changed" ? "transcript publication changed · downloaded audio kept"
    : transcript.reason === "TooLarge" ? "transcript exceeds download limit · downloaded audio kept"
    : transcript.reason === "E_MEDIA_NOT_READY" ? "no published transcript was available at download · remove and download again for newer content" : "transcript download failed · downloaded audio kept";
  return null;
}

export default function DownloadsPaneBody() {
  const { index, error } = useLocalContent();
  const guard = useWorkGuard();
  const [confirmation, setConfirmation] = useState<{ title: string; message: string; label: string; danger: boolean; run: () => void } | null>(null);
  const listening = useListening();
  const { state: player } = usePlayerSession();
  const { playAudio, pause } = usePlayerCommands();
  const { run } = useActionRuntime();
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef<Map<string, LocalItem["state"]> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  usePaneReturnReady(!localContentAvailable || index !== null || error !== null);
  useEffect(() => {
    if (index === null) return;
    if (previous.current !== null) {
      const changed = index.items.filter(item => previous.current?.has(item.media_id) && previous.current.get(item.media_id) !== item.state && (item.state === "Ready" || item.state === "Failed"));
      if (changed.length > 0) setAnnouncement(changed.map(item => `${item.title}: ${status(item)}`).join(". "));
    }
    previous.current = new Map(index.items.map(item => [item.media_id, item.state]));
  }, [index]);
  async function change(key: string, op: string, args: Record<string, unknown>) {
    if (busy !== null) return;
    setBusy(key); setFailure(null);
    try { await localMutation(op, args); }
    catch { setFailure("download change not confirmed · try again"); }
    finally { setBusy(null); }
  }
  async function remove(item: LocalItem, trigger: HTMLElement) {
    const ownedFocus = root.current?.querySelector(`[data-download-id="${item.media_id}"]`)?.contains(document.activeElement);
    await change(item.media_id, "remove", { media_id: item.media_id });
    if (ownedFocus && (!trigger.isConnected || document.activeElement === document.body))
      (root.current?.querySelector<HTMLElement>("[data-row-focusable]") ?? heading.current)?.focus({ preventScroll: true });
  }
  function play(item: LocalItem) {
    if (player.kind === "Loaded" && player.source.kind === "Episode" && player.source.descriptor.media_id === item.media_id && player.phase === "Playing") return pause();
    run({ ref: `media:${item.media_id}`, id: "Playback", label: "play", title: item.title, confirmation: null, tracked: false,
      execute: () => playAudio({ mediaId: item.media_id, knownDescriptor: null, positionMs: null, source: null, recapture: false }) });
  }
  if (!localContentAvailable) return <FeedbackState content={{ tone: "Neutral", title: "downloads require the android app" }} announcement="None" />;
  if (index === null) return <FeedbackState content={{ tone: error === null ? "Neutral" : "Warning", title: error?.message ?? "opening downloads…" }} announcement="Polite" />;
  return <div ref={root} className={styles.body}>
    <h1 ref={heading} tabIndex={-1}>downloads</h1>
    <span className="sr-only" role="status">{announcement}</span>
    {error === null ? null : <FeedbackNotice content={{ tone: "Warning", title: "downloads couldn’t refresh", message: error.message }} announcement="Polite" />}
    {failure === null ? null : <FeedbackNotice content={{ tone: "Warning", title: failure }} announcement="Assertive" />}
    {index.auth_required ? <FeedbackNotice content={{ tone: "Warning", title: "sign in for remote downloads and progress sync", message: "downloaded content stays available on this device." }} announcement="Polite" /> : null}
    <div className={styles.summary}>
      <span>{formatByteCount(index.items.reduce((sum, item) => sum + (item.state === "Ready" ? item.size_bytes : 0), 0))} downloaded</span>
      <label className={styles.policy}><input type="checkbox" checked={index.policy === "AnyConnected"} disabled={busy !== null}
        onChange={event => {
          const allow = event.currentTarget.checked;
          if (allow) setConfirmation({ title: "allow mobile data downloads?", message: "this applies to all queued downloads.", label: "allow mobile data", danger: false,
            run: () => { void change("policy", "policy", { value: "AnyConnected" }); } });
          else void change("policy", "policy", { value: "UnmeteredOnly" });
        }} />download over mobile data</label>
    </div>
    {index.items.length === 0 ? <FeedbackState content={{ tone: "Neutral", title: "no downloads", message: "download episodes or reading copies from their action menus." }} announcement="None" /> :
      <ResourceList ariaLabel="downloads">{index.items.map(item => {
        const local = listening.facts?.episodes.get(item.media_id)?.local;
        const playing = player.kind === "Loaded" && player.source.kind === "Episode" && player.source.descriptor.media_id === item.media_id && player.phase === "Playing";
        const supplemental = extras(item);
        const missing = item.extras !== null && Object.values(item.extras).some(extra => extra.kind === "Failed" && extra.reason !== "Changed" && extra.reason !== "TooLarge" && extra.reason !== "E_MEDIA_NOT_READY");
        return <ResourceRow key={item.media_id} rootProps={{ "data-download-id": item.media_id }}
          title={item.title} primary={{ kind: "link", href: `/media/${item.media_id}` }}
          content={{ kind: "Details", body: <>
            <p className={styles.status}>{status(item)}</p>
            {supplemental === null ? null : <p className={styles.status}>{supplemental}</p>}
            {item.extras?.artwork.kind === "Failed" ? <p className={styles.status}>{item.extras.artwork.reason === "TooLarge" ? "artwork exceeds download limit" : "artwork download failed"}</p>
              : item.extras?.artwork.kind === "Pending" ? <p className={styles.status}>artwork download pending</p>
              : item.extras?.artwork.kind === "Absent" ? <p className={styles.status}>no published artwork</p> : null}
            {local === undefined || local === null ? null : <p className={styles.status}>{local.disposition === "SourceUnavailable" ? item.package_id === null ? "original no longer available · listening saved locally" : "original no longer available · downloaded copy kept" : "listening saved on this device"}</p>}
            {item.progress === null ? null : <p className={styles.status}>{item.progress.kind === "Canonical" ? "reading position synced" : item.progress.kind === "Conflict" ? "reading position needs your choice" : "reading position saved on this device"}</p>}
            <div className={styles.actions}>
              {item.state === "Ready" && item.kind === "podcast_episode" && item.package_id !== null ? <Button onClick={() => play(item)}>{playing ? "pause" : "play"}</Button> : null}
              {item.state === "Ready" && item.kind !== "podcast_episode" ? <Button onClick={() => { if (guard.confirmDocumentExit()) void localCall("open_reader", { media_id: item.media_id }).catch(() => setFailure("downloaded copy couldn’t open · try again")); }}>read downloaded copy</Button> : null}
              {item.state === "Queued" || item.state === "Downloading" ? <Button disabled={busy !== null} onClick={() => void change(item.media_id, "cancel", { media_id: item.media_id })}>cancel</Button> : null}
              {item.state === "Failed" ? <Button disabled={busy !== null} onClick={() => void change(item.media_id, "retry", { media_id: item.media_id })}>{item.failure === "NeedsDownload" ? "download again" : "retry download"}</Button> : null}
              {item.state === "Ready" && missing && item.package_id !== null ? <Button disabled={busy !== null} onClick={() => void change(item.media_id, "retry_extras", { media_id: item.media_id, package_id: item.package_id })}>retry missing content</Button> : null}
              {local?.disposition === "SourceUnavailable" ? <Button onClick={() => void retryNativeListening(item.media_id).catch(() => setFailure("listening sync not confirmed · try again"))}>retry listening sync</Button> : null}
              {item.state === "Ready" || item.state === "Failed" ? <Button tone="danger" disabled={busy !== null} onClick={event => {
                const trigger = event.currentTarget;
                if (item.kind !== "podcast_episode" && item.progress !== null && item.progress.kind !== "Canonical") setConfirmation({
                  title: "remove downloaded copy?", message: "its reading position has not reached nexus and will be lost.", label: "remove copy and position", danger: true,
                  run: () => { void remove(item, trigger); },
                });
                else void remove(item, trigger);
              }}>remove</Button> : null}
            </div>
          </> }} />;
      })}</ResourceList>}
    {confirmation === null ? null : <Dialog open title={confirmation.title} onClose={() => setConfirmation(null)}>
      <p>{confirmation.message}</p><div className={styles.actions}>
        <Button emphasis="strong" tone={confirmation.danger ? "danger" : undefined} onClick={() => { const chosen = confirmation; setConfirmation(null); chosen.run(); }}>{confirmation.label}</Button>
        <Button onClick={() => setConfirmation(null)}>cancel</Button>
      </div>
    </Dialog>}
  </div>;
}
