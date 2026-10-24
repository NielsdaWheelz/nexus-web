// The isolated shelf reads non-episode copies. Download management belongs to the workspace.
import { useEffect, useRef, useState } from "react";
import { FeedbackNotice, FeedbackState } from "@/components/feedback/Feedback";
import Dialog from "@/components/ui/Dialog";
import Button from "@/components/ui/Button";
import { localCall, localMutation, useLocalContent, type LocalItem } from "@/lib/offline/localContent";
import ShelfReader from "./ShelfReader";
import styles from "./shelf.module.css";

export default function Shelf() {
  const { index, error } = useLocalContent();
  const [hash, setHash] = useState(() => window.location.hash);
  const [opened, setOpened] = useState<LocalItem | null>(null);
  const [confirmRemoval, setConfirmRemoval] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
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
    setFailure(null);
    void localCall("open", { media_id: availableId }).then(() => {
      if (active) setOpened(currentCandidate.current);
    }, () => { if (active) setFailure("this downloaded copy couldn’t be opened"); });
    return () => {
      active = false;
      setOpened(null);
      void localCall("close", { media_id: availableId });
    };
  }, [availableId]);
  const back = () => { void localCall("open_hosted", { path: "/downloads" }).catch(() => setFailure("couldn’t open downloads · try again")); };
  const item = opened === null ? null : index?.items.find(row => row.media_id === opened.media_id) ?? opened;
  const remove = () => {
    if (item === null) return;
    void localMutation("remove", { media_id: item.media_id }).then(back,
      () => setFailure("removal not confirmed · try again"));
  };
  return <main className={`${styles.shell} ${styles.readerShell}`}>
    <header className={styles.readerHeader}>
      <Button onClick={back}>downloads</Button>
      {item === null ? null : <h1>{item.title}</h1>}
    </header>
    {failure === null ? null : <FeedbackNotice content={{ tone: "Warning", title: failure }} announcement="Assertive" />}
    {item !== null ? <ShelfReader key={item.media_id} item={item} onRemove={() => { if (item.progress !== null && item.progress.kind !== "Canonical") setConfirmRemoval(true); else remove(); }} />
      : <FeedbackState content={{ tone: error === null && index === null ? "Neutral" : "Warning",
        title: error?.message ?? (index === null ? "opening downloaded copy…" : "downloaded copy unavailable") }} announcement="Polite" />}
    {confirmRemoval ? <Dialog open title="remove downloaded copy?" onClose={() => setConfirmRemoval(false)}>
      <p>its reading position has not reached nexus and will be lost.</p><div className={styles.actions}>
        <Button tone="danger" onClick={() => { setConfirmRemoval(false); remove(); }}>remove copy and position</Button>
        <Button onClick={() => setConfirmRemoval(false)}>cancel</Button>
      </div>
    </Dialog> : null}
  </main>;
}
