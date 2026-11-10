"use client";

/** Explicit addresses are private account input, never directory searches. */
import { useRef, useState } from "react";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneSurface from "@/components/ui/PaneSurface";
import { Fact } from "@/components/feedback/Fact";
import { useOutcome } from "@/components/feedback/Feedback";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { resolveFeed } from "@/lib/feeds/api";
import { useImportIntake } from "@/lib/imports/intake";
import { usePaneChrome } from "@/lib/panes/paneChrome";
import { usePaneRouter } from "@/lib/panes/paneRuntime";
import { usePaneReturnReady } from "@/lib/workspace/paneReturnMemento";
import styles from "./FeedCommands.module.css";

type Resolution = Awaited<ReturnType<typeof resolveFeed>>;
export default function FeedBrowse() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [choice, setChoice] = useState<Resolution | null>(null);
  const { ctx } = useActionRuntime();
  const router = usePaneRouter();
  const { fail } = useOutcome();
  const intake = useImportIntake();
  const file = useRef<HTMLInputElement>(null);
  usePaneChrome({ header: { kind: "Section", meta: { kind: "None" } } });
  usePaneReturnReady(true);
  const resolve = async (address: string, selected_kind: "podcast" | "article" | null = null) => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await resolveFeed({ kind: "Url", url: address.trim(), selected_kind }, ctx.sessionSignal());
      if (result.state === "resolved") router.push(result.href);
      else setChoice(result);
    } catch (error) { fail(error, "couldn’t open this feed."); }
    finally { setBusy(false); }
  };
  return <PaneSurface><div className={styles.form}>
    <form onSubmit={event => { event.preventDefault(); void resolve(url); }} className={styles.form}>
      <label>website or feed url<Input type="url" value={url} onChange={event => { setUrl(event.target.value); setChoice(null); }} required autoComplete="off" /></label>
      <div className={styles.actions}><Button type="submit" disabled={busy || url.trim() === ""} aria-busy={busy || undefined}>open feed</Button>
        <Button onClick={() => file.current?.click()}>import opml</Button></div>
    </form>
    <input ref={file} type="file" accept=".opml,text/x-opml,text/x-opml+xml,application/xml,text/xml" hidden onChange={event => {
      const selected = event.currentTarget.files?.[0]; if (selected) intake.admit({ links: [], files: [], opml: [selected] }); event.currentTarget.value = "";
    }} />
    <a href="/api/feeds/opml" download="subscriptions.opml">export active subscriptions</a>
    {choice?.state === "choose_url" ? <><Fact line={{ fact: "choose a feed from this site." }} /><ul className={styles.destinations}>{choice.choices.map(item => <li key={item.url}><Button disabled={busy} onClick={() => void resolve(item.url)}>{item.title || item.url}</Button></li>)}</ul></> : null}
    {choice?.state === "choose_kind" ? <><Fact line={{ fact: "choose what to follow from this feed." }} /><div className={styles.actions}>{choice.choices.map(kind => <Button key={kind} disabled={busy} onClick={() => void resolve(choice.url, kind)}>{kind === "podcast" ? "podcast" : "articles"}</Button>)}</div></> : null}
  </div></PaneSurface>;
}
