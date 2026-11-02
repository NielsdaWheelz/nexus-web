// The isolated shelf reads non-episode copies. Download management belongs to the workspace.
import { useEffect, useRef, useState } from "react";
import { FeedbackProvider, Hold, useOutcome } from "@/components/feedback/Feedback";
import { Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { StageAnchor } from "@/components/feedback/Slips";
import type { Shell } from "@/components/feedback/stage";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import { localCall, localMutation, useLocalContent, type LocalItem } from "@/lib/offline/localContent";
import ShelfReader from "./ShelfReader";
import styles from "./shelf.module.css";

/** Sign-in belongs to the workspace: the shelf's verb opens it. */
const SHELL: Shell = { signIn: { label: "open workspace", commandKey: "OpenWorkspace", run: () => { void localCall("open_hosted", { path: "/downloads" }).catch(reportError); } } };

export default function Shelf() {
  return <FeedbackProvider shell={SHELL}><main tabIndex={-1} className={`${styles.shell} ${styles.readerShell}`}>
    <StageAnchor kind="Root" />
    <ShelfContent />
  </main></FeedbackProvider>;
}

function ShelfContent() {
  const { index, error } = useLocalContent();
  const { say } = useOutcome();
  const [attempt, retryOpen] = useState(0);
  const [opening, setOpening] = useState(false);
  const [hash, setHash] = useState(() => window.location.hash);
  const [opened, setOpened] = useState<LocalItem | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [openFailed, setOpenFailed] = useState(false);
  const [removal, setRemoval] = useState<{ attempt: number } | null>(null);
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
      if (active) { setOpened(currentCandidate.current); setOpenFailed(false); setOpening(false); }
    }, () => { if (active) { setOpenFailed(true); setOpening(false); } });
    return () => {
      active = false;
      setOpened(null);
      void localCall("close", { media_id: availableId });
    };
  }, [availableId, attempt]);
  useEffect(() => {
    if (opened === null || opened.media_id !== mediaId) return;
    let sent = false;
    const acknowledge = () => {
      // The hash can change before React sees it; the lease alone is not admission.
      if (sent || document.visibilityState !== "visible" || window.location.hash !== `#open=${opened.media_id}`) return;
      sent = true;
      void localCall("opened", { media_id: opened.media_id }).catch(() => undefined);
    };
    acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    return () => document.removeEventListener("visibilitychange", acknowledge);
  }, [opened, mediaId]);
  const back = () => { void localCall("open_hosted", { path: "/downloads" }).catch(() => say({ fact: "couldn’t open downloads." })); };
  const item = opened === null || opened.media_id !== mediaId ? null : index?.items.find(row => row.media_id === opened.media_id) ?? opened;
  const remove = () => {
    if (item === null) return;
    void localMutation("remove", { media_id: item.media_id }).then(() => { setRemoval(null); back(); },
      () => setRemoval(current => ({ attempt: current === null ? 0 : current.attempt + 1 })));
  };
  return <>
    <header className={styles.readerHeader}>
      <Button onClick={back}>downloads</Button>
      {item === null ? null : <h1>{item.title}</h1>}
    </header>
    {removal === null ? null : <Hold id="shelf-removal" attempt={removal.attempt} line={{ fact: "not sure that saved. it may have gone through." }}
      verbs={[{ label: "open downloads", commandKey: "OpenDownloads", run: back }]} />}
    {item !== null ? <ShelfReader key={item.media_id} item={item} onRemove={() => { if (item.progress !== null && item.progress.kind !== "Canonical") setConfirmRemoval(true); else remove(); }} />
      : openFailed ? <Fact line={{ fact: "couldn’t open this downloaded copy." }} verbs={[{ label: "retry", commandKey: "RetryOpenCopy", busy: opening, run: () => retryOpen(value => value + 1) }]} speak />
      : error === null && (index === null || availableId !== null) ? <Ruling />
      : <Fact line={{ fact: "this downloaded copy isn’t available." }} speak />}
    {confirmRemoval ? <Dialog open title="remove downloaded copy?" onClose={() => setConfirmRemoval(false)}>
      <p>its reading position has not reached nexus and will be lost.</p><div className={styles.actions}>
        <Button tone="danger" onClick={() => { setConfirmRemoval(false); remove(); }}>remove copy and position</Button>
        <Button onClick={() => setConfirmRemoval(false)}>cancel</Button>
      </div>
    </Dialog> : null}
  </>;
}
