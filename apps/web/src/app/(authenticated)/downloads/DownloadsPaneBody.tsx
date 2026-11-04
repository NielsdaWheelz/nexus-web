"use client";

import { DeviceListeningStatus } from "@/lib/native/localStateStatus";

// Device-owned downloads, independent of catalog coverage and remote admission. Each row
// carries its own status; a refused change speaks once and the native index shows the truth.
// Native error text goes to the log, never to the page.
import { useEffect, useRef, useState } from "react";
import { Fact } from "@/components/feedback/Fact";
import { useOutcome } from "@/components/feedback/Feedback";
import { Announcement } from "@/components/feedback/Announcement";
import { Ruling } from "@/components/feedback/Ruling";
import Button from "@/components/ui/Button";
import ChoiceField from "@/components/ui/ChoiceField";
import Dialog from "@/components/ui/Dialog";
import { useWorkGuard } from "@/lib/unsavedWork";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { localCall, localContentAvailable, localMutation, LocalMutationObservationError, useLocalContent, type FailureReason, type LocalItem } from "@/lib/offline/localContent";
import { useListening } from "@/lib/consumption/listening";
import { retryNativeListening } from "@/lib/player/nativeEngine";
import { usePlayerCommands, usePlayerSession } from "@/lib/player/playerRuntime";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import { formatByteCount } from "@/lib/text/formatByteCount";
import styles from "./downloads.module.css";

const FAILURE: Record<FailureReason, string> = {
  AuthorizationRequired: "sign in to download",
  SourceUnavailable: "original no longer available",
  Changed: "couldn’t download",
  Storage: "couldn’t save to device storage", Network: "network interrupted", Server: "nexus isn’t answering",
  Invalid: "couldn’t use the downloaded file", Stopped: "stopped by android", Scheduler: "android couldn’t schedule it", NeedsDownload: "needs a fresh download",
};
function status(item: LocalItem): string {
  switch (item.state) {
    case "Queued": return item.attempts > 0 ? "queued · retrying after interruption" : "queued";
    case "Downloading": return item.total === null ? `${formatByteCount(item.received)} received`
      : `${formatByteCount(item.received)} of ${formatByteCount(item.total)}`;
    case "Ready": return `downloaded · ${formatByteCount(item.size_bytes)}`;
    case "Removing": return item.kind === "podcast_episode" ? "removal pending · episode still open" : "removal pending · copy still open";
    case "Failed": return item.failure === null ? "couldn’t download" : FAILURE[item.failure];
  }
}
function extras(item: LocalItem): string | null {
  const transcript = item.extras?.transcript;
  if (transcript === undefined) return null;
  if (transcript.kind === "Absent") return "no published transcript";
  if (transcript.kind === "Pending") return "transcript download pending";
  if (transcript.kind === "Failed") return transcript.reason === "Changed" ? "couldn’t download the transcript · audio kept"
    : transcript.reason === "TooLarge" ? "transcript exceeds download limit · downloaded audio kept"
    : transcript.reason === "E_MEDIA_NOT_READY" ? "no published transcript was available at download · remove and download again for newer content" : "couldn’t download the transcript · audio kept";
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
  const outcome = useOutcome();
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef<Map<string, LocalItem["state"]> | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  usePaneReturnReady(!localContentAvailable || index !== null || error !== null);
  useEffect(() => { if (error !== null) console.warn("downloads_index_unread", error.message); }, [error]);
  useEffect(() => {
    if (index === null) return;
    if (previous.current !== null) {
      const changed = index.items.filter(item => previous.current?.has(item.media_id) && previous.current.get(item.media_id) !== item.state && (item.state === "Ready" || item.state === "Failed"));
      if (changed.length > 0) setAnnouncement(changed.map(item => `${item.title}: ${status(item)}`).join(". "));
    }
    previous.current = new Map(index.items.map(item => [item.media_id, item.state]));
  }, [index]);
  /** One native change; `fact` says what a refusal couldn't do. */
  async function change(key: string, op: string, args: Record<string, unknown>, fact: string) {
    if (busy !== null) return;
    setBusy(key);
    try { await localMutation(op, args); }
    catch (error) { if (!(error instanceof LocalMutationObservationError)) outcome.say({ fact }); }
    finally { setBusy(null); }
  }
  async function remove(item: LocalItem, trigger: HTMLElement) {
    const ownedFocus = root.current?.querySelector(`[data-download-id="${item.media_id}"]`)?.contains(document.activeElement);
    await change(item.media_id, "remove", { media_id: item.media_id }, `couldn’t remove “${item.title}”.`);
    if (ownedFocus && (!trigger.isConnected || document.activeElement === document.body))
      (root.current?.querySelector<HTMLElement>("[data-row-focusable]") ?? heading.current)?.focus({ preventScroll: true });
  }
  function play(item: LocalItem) {
    if (player.kind === "Loaded" && player.source.descriptor.media_id === item.media_id && player.phase === "Playing") return pause();
    run({ ref: `media:${item.media_id}`, id: "Playback", label: "play", feedbackLabel: "play", title: item.title, confirmation: null, tracked: false,
      execute: () => playAudio({ mediaId: item.media_id, knownDescriptor: null, positionMs: null, source: null, recapture: false }) });
  }
  if (!localContentAvailable) return <Fact line={{ fact: "downloads need the android app." }} />;
  if (index === null) return error === null ? <Ruling /> : <Fact line={{ fact: "couldn’t read downloads on this device." }} speak />;
  return <div ref={root} className={styles.body}>
    <DeviceListeningStatus />
    <h1 ref={heading} tabIndex={-1}>downloads</h1>
    <Announcement text={announcement} level="Polite" />
    {index.auth_required ? <Fact line={{ fact: "sign in to download and sync progress.", reason: "what’s downloaded stays here." }} /> : null}
    <div className={styles.summary}>
      <span>{formatByteCount(index.items.reduce((sum, item) => sum + (item.state === "Ready" ? item.size_bytes : 0), 0))} downloaded</span>
      <ChoiceField label="download over mobile data" checked={index.policy === "AnyConnected"} disabled={busy !== null}
        onChange={allow => {
          const fact = "couldn’t change the mobile data setting.";
          if (allow) setConfirmation({ title: "allow mobile data downloads?", message: "this applies to all queued downloads.", label: "allow mobile data", danger: false,
            run: () => { void change("policy", "policy", { value: "AnyConnected" }, fact); } });
          else void change("policy", "policy", { value: "UnmeteredOnly" }, fact);
        }} />
    </div>
    {index.items.length === 0 ? <Fact line={{ fact: "no downloads yet.", reason: "download episodes and documents from their menus." }} /> :
      <ResourceList ariaLabel="downloads">{index.items.map(item => {
        const local = listening.facts?.episodes.get(item.media_id)?.local;
        const playing = player.kind === "Loaded" && player.source.descriptor.media_id === item.media_id && player.phase === "Playing";
        const supplemental = extras(item);
        const missing = item.extras !== null && Object.values(item.extras).some(extra => extra.kind === "Failed" && extra.reason !== "Changed" && extra.reason !== "TooLarge" && extra.reason !== "E_MEDIA_NOT_READY");
        return <ResourceRow key={item.media_id} rootProps={{ "data-download-id": item.media_id }}
          title={item.title} primary={{ kind: "link", href: `/media/${item.media_id}` }}
          content={{ kind: "Details", body: <>
            <p className={styles.status}>{status(item)}</p>
            {supplemental === null ? null : <p className={styles.status}>{supplemental}</p>}
            {item.extras?.artwork.kind === "Failed" ? <p className={styles.status}>{item.extras.artwork.reason === "TooLarge" ? "artwork exceeds download limit" : "couldn’t download artwork"}</p>
              : item.extras?.artwork.kind === "Pending" ? <p className={styles.status}>artwork download pending</p>
              : item.extras?.artwork.kind === "Absent" ? <p className={styles.status}>no published artwork</p> : null}
            {local === undefined || local === null ? null : <p className={styles.status}>{local.disposition === "SourceUnavailable" ? item.package_id === null ? "original no longer available · listening saved locally" : "original no longer available · downloaded copy kept" : "listening saved on this device"}</p>}
            {item.progress === null ? null : <p className={styles.status}>{item.progress.kind === "Canonical" ? "reading position synced" : item.progress.kind === "Conflict" ? "reading position needs your choice" : "reading position saved on this device"}</p>}
            <div className={styles.actions}>
              {item.state === "Ready" && item.kind === "podcast_episode" && item.package_id !== null ? <Button onClick={() => play(item)}>{playing ? "pause" : "play"}</Button> : null}
              {item.state === "Ready" && item.kind !== "podcast_episode" ? <Button onClick={() => { if (guard.confirmDocumentExit()) void localCall("open_reader", { media_id: item.media_id }).catch(() => outcome.say({ fact: `couldn’t open “${item.title}”.` })); }}>read downloaded copy</Button> : null}
              {item.state === "Queued" || item.state === "Downloading" ? <Button disabled={busy !== null} onClick={() => void change(item.media_id, "cancel", { media_id: item.media_id }, `couldn’t cancel “${item.title}”.`)}>cancel</Button> : null}
              {item.state === "Failed" ? <Button disabled={busy !== null} onClick={() => void change(item.media_id, "retry", { media_id: item.media_id }, `couldn’t restart “${item.title}”.`)}>{item.failure === "NeedsDownload" ? "download again" : "retry download"}</Button> : null}
              {item.state === "Ready" && missing && item.package_id !== null ? <Button disabled={busy !== null} onClick={() => void change(item.media_id, "retry_extras", { media_id: item.media_id, package_id: item.package_id }, `couldn’t fetch the rest of “${item.title}”.`)}>retry missing content</Button> : null}
              {local?.disposition === "SourceUnavailable" ? <Button onClick={() => void retryNativeListening(item.media_id).catch(() => outcome.say({ fact: `couldn’t restart listening sync for “${item.title}”.` }))}>retry listening sync</Button> : null}
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
