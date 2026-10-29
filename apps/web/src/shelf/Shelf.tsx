// The isolated shelf reads non-episode copies. Download management belongs to the workspace.
import { useEffect, useRef, useState } from "react";
import { FeedbackBusy, FeedbackFailure, FeedbackProvider, FeedbackRecoveryControl, FeedbackState, useFeedbackOccurrence } from "@/components/feedback/Feedback";
import FeedbackSurface from "@/components/feedback/FeedbackSurface";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import { localCall, localMutation, useLocalContent, type LocalItem } from "@/lib/offline/localContent";
import ShelfReader from "./ShelfReader";
import styles from "./shelf.module.css";

export default function Shelf() {
  const { index, error } = useLocalContent();
  const [bounds, setBounds] = useState<HTMLElement | null>(null);
  const [attempt, retryOpen] = useState(0);
  const [opening, setOpening] = useState(false);
  const [hash, setHash] = useState(() => window.location.hash);
  const [opened, setOpened] = useState<LocalItem | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [failure, setFailure] = useState<{ kind: "Open" | "Downloads" | "Remove"; title: string } | null>(null);
  const occurrence = useFeedbackOccurrence(failure !== null, failure?.kind);
  const mediaId = /^#open=([0-9a-f-]{36})$/.exec(hash)?.[1] ?? null;
  const candidate = index?.items.find(item => item.media_id === mediaId && item.kind !== "podcast_episode" && item.state === "Ready") ?? null;
  useEffect(() => {
    const changed = () => setHash(window.location.hash);
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const currentCandidate = useRef(candidate);
  currentCandidate.current = candidate;
  const availableId = opened?.media_id === mediaId ? mediaId : candidate?.media_id ?? null;
  useEffect(() => {
    if (availableId === null) return;
    let active = true;
    setOpening(true);
    void localCall("open", { media_id: availableId }).then(() => {
      if (active) { setOpened(currentCandidate.current); setFailure(null); setOpening(false); }
    }, () => { if (active) { setFailure({ kind: "Open", title: "this downloaded copy couldn’t be opened" }); setOpening(false); } });
    return () => {
      active = false;
      setOpened(null);
      void localCall("close", { media_id: availableId });
    };
  }, [availableId, attempt]);
  const back = () => { void localCall("open_hosted", { path: "/downloads" }).catch(() => setFailure({ kind: "Downloads", title: "couldn’t open downloads" })); };
  const item = opened === null || opened.media_id !== mediaId ? null : index?.items.find(row => row.media_id === opened.media_id) ?? opened;
  const remove = () => {
    if (item === null) return;
    void localMutation("remove", { media_id: item.media_id }).then(back,
      () => setFailure({ kind: "Remove", title: "removal not confirmed" }));
  };
  return <FeedbackProvider><main ref={setBounds} tabIndex={-1} className={`${styles.shell} ${styles.readerShell}`}>
    <FeedbackSurface bounds={bounds} interaction={null} modal={null} active protectedTargets={() => bounds ? [...bounds.querySelectorAll<HTMLElement>("header")] : []} returnFocus={() => bounds}>
    <header className={styles.readerHeader}>
      <Button onClick={back}>downloads</Button>
      <FeedbackRecoveryControl />
      {item === null ? null : <h1>{item.title}</h1>}
    </header>
    {failure === null ? null : <FeedbackFailure scope="Local" occurrence={occurrence} content={{ tone: "Warning", title: failure.title, message: failure.kind === "Remove" ? "the request may have succeeded." : undefined }} announcement="Polite"
      actions={[{ label: failure.kind === "Open" ? "retry opening" : "open downloads", onClick: failure.kind === "Open" ? () => retryOpen(value => value + 1) : back, busy: failure.kind === "Open" && opening }]} />}
    {item !== null ? <ShelfReader key={item.media_id} item={item} onRemove={() => { if (item.progress !== null && item.progress.kind !== "Canonical") setConfirmRemoval(true); else remove(); }} />
      : error === null && (index === null || availableId !== null && (opening || failure?.kind !== "Open")) ? <FeedbackBusy pending subject={availableId} /> : <FeedbackState content={{ tone: "Warning", title: "downloaded copy unavailable" }} announcement="Polite" />}
    {confirmRemoval ? <Dialog open title="remove downloaded copy?" onClose={() => setConfirmRemoval(false)}>
      <p>its reading position has not reached nexus and will be lost.</p><div className={styles.actions}>
        <Button tone="danger" onClick={() => { setConfirmRemoval(false); remove(); }}>remove copy and position</Button>
        <Button onClick={() => setConfirmRemoval(false)}>cancel</Button>
      </div>
    </Dialog> : null}
    </FeedbackSurface>
  </main></FeedbackProvider>;
}
