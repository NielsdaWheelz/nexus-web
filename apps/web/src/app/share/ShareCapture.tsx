"use client";

/** The manifest alone grants arrival admission and native share exits. Imports use the
 * document's intake without a truth host; plain text keeps its authored capture handle. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { useTransportVerbs, type CommandVerb, type Shell } from "@/components/feedback/stage";
import { TRANSPORT_LINES, transportOf } from "@/lib/api/failure";
import { Failed, Fact } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import { StageAnchor } from "@/components/feedback/Slips";
import ImportLine, { type ButtonVerb } from "@/components/nexus/ImportLine";
import Button from "@/components/ui/Button";
import { ApiError, isApiError, readResponse, requestWithDeadline, WIRE_HEADER } from "@/lib/api/client";
import { WIRE_REVISION } from "@/lib/api/wire.gen";
import { useFailedReadRepair } from "@/lib/api/serverState";
import { loginPath, parseReturnTarget } from "@/lib/auth/urls";
import { extractLinks } from "@/lib/extractLinks";
import { ADMIT_LIMIT, ImportIntakeProvider, useImportIntake, type IntakeLine } from "@/lib/imports/intake";
import { lineView, linkPointer } from "@/lib/imports/lineView";
import { formatLocalDateInTimeZone, isLocalDate } from "@/lib/localDate";
import { dailyId, linkId } from "@nexus/authored/identity";
import { isVisible } from "@nexus/authored/merge";
import { captureToday } from "@/lib/notes/api";
import { getWritingRuntime, isAuthoredStorageFailure, LocalCommitError } from "@/lib/notes/runtime";
import { AuthoredProvider } from "@/lib/authored/provider";
import { readBrowserBinding } from "@/lib/authored/binding";
import { hello, readDeviceStartup } from "@/lib/native/client";
import { installedApp, subscribeAdmission, subscribeRepair, updateRemedy } from "@/lib/native/admission";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";
import { WorkProvider, useWorkGuard } from "@/lib/unsavedWork";
import { isRecord } from "@/lib/validation";
import styles from "./share.module.css";

type SharedFile = { index: number; name: string | null; size: number | null; type: string | null };
type Share = { kind: "Manual" } | { kind: "Activity"; entries: readonly SharedFile[] };
type ShareAccount = { user_id: string; calendar_time_zone: string; capture: { noteId: string; localDate: string } | null };
/** No local binding yet, or a share made for another account than the one open here. */
class CaptureAdmissionError extends Error {
  constructor(readonly kind: "Unbound" | "OtherAccount") { super(kind); }
}

const openPath = (share: Share, path: string) => share.kind === "Activity" ? `nexus-share://open?path=${encodeURIComponent(path)}` : path;
const donePath = (share: Share) => share.kind === "Activity" ? "nexus-share://done" : APP_AUTHENTICATED_HOME_HREF;
const signIn = () => window.location.assign(installedApp ? "nexus://auth/start" : loginPath(parseReturnTarget(`${location.pathname}${location.search}`)));
const SHELL: Shell = { signIn: { label: "sign in", commandKey: "share:sign-in", run: signIn } };

/** Native streams are outside the API envelope; the normal wire and read budget still apply. */
function readShared<T>(path: string, signal: AbortSignal, read: (response: Response) => Promise<T>): Promise<T> {
  return requestWithDeadline({ signal, timeoutMs: 30_000, request: async signal => {
    try {
      return await read(await fetch(path, { signal, cache: "no-store", headers: { [WIRE_HEADER]: String(WIRE_REVISION) } }));
    } catch (error) {
      if (error instanceof TypeError) throw new ApiError(0, "E_NETWORK", "shared file transport failed");
      throw error;
    }
  } });
}

export default function ShareCapture(props: { text: string; files: number }) {
  return <FeedbackProvider shell={SHELL}><div tabIndex={-1} className={styles.backdrop}>
    <StageAnchor kind="Root" />
    <main className={styles.card}><div className={styles.capture}>
      <ShareDocument {...props} />
    </div></main>
  </div></FeedbackProvider>;
}

/** Main's standalone share document still needs the native session subscription. */
function ShareDocument(props: { text: string; files: number }) {
  const [ready, setReady] = useState(!installedApp);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [opening, setOpening] = useState(installedApp);
  const [attempt, retry] = useState(0);
  useFailedReadRepair(failure !== null, opening, () => { setOpening(true); retry(value => value + 1); });
  useEffect(() => {
    if (!installedApp) return;
    let active = true;
    void hello().then(() => { if (active) { setReady(true); setFailure(null); } }, error => { if (active) setFailure(error); })
      .finally(() => { if (active) setOpening(false); });
    return () => { active = false; };
  }, [attempt]);
  if (!ready) return failure === null ? <Ruling />
    : <Failed error={failure} noun="share" retry={{ busy: opening, run: () => { setOpening(true); retry(value => value + 1); } }} />;
  return <WorkProvider><ShareAdmission {...props} /></WorkProvider>;
}

function ShareAdmission({ text, files }: { text: string; files: number }) {
  const [share, setShare] = useState<Share | null>(null);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [reading, setReading] = useState(true);
  const [attempt, retry] = useState(0);
  const links = useMemo(() => extractLinks(text, "Urls").links, [text]);
  useFailedReadRepair(failure !== null, reading, () => { setReading(true); retry(value => value + 1); });
  useEffect(() => {
    const scope = new AbortController();
    void readShared("/_nexus/shared/manifest", scope.signal, async response => {
      if (response.status === 404) return { kind: "Manual" } as const;
      const value = await readResponse<unknown>(response);
      if (response.status !== 200 || !Array.isArray(value) || value.length !== files ||
        !value.every((entry, index) => isRecord(entry) && entry.index === index &&
          (entry.name === null || typeof entry.name === "string") &&
          (entry.size === null || typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0) &&
          (entry.type === null || typeof entry.type === "string")))
        throw new ApiError(response.status, "E_INVALID_RESPONSE", "invalid native share manifest");
      return { kind: "Activity", entries: value as SharedFile[] } as const;
    }).then(value => { if (!scope.signal.aborted) { setShare(value); setFailure(null); } },
      error => { if (!scope.signal.aborted) setFailure(error); })
      .finally(() => { if (!scope.signal.aborted) setReading(false); });
    return () => scope.abort();
  }, [attempt, files]);
  if (failure !== null) return <Failed error={failure} noun="share" retry={{ busy: reading, run: () => { setReading(true); retry(value => value + 1); } }} />;
  if (share === null) return <Ruling />;
  if (!(files > 0) && links.length === 0) return text.trim() === ""
    ? <><Fact line={{ fact: "this share was empty." }} /><a className={styles.action} href={donePath(share)}>done</a></>
    : <PlainShareAdmission text={text} share={share} />;
  return <ImportIntakeProvider accountId={null}><SharedImports links={links} share={share} /></ImportIntakeProvider>;
}

function SharedImports({ links, share }: { links: readonly string[]; share: Share }) {
  const intake = useImportIntake();
  const { admit, hasAdmitted } = intake;
  const total = links.length + (share.kind === "Activity" ? share.entries.length : 0);
  const [preparing, setPreparing] = useState(share.kind === "Activity" && total > 0 && total <= ADMIT_LIMIT);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [attempt, retry] = useState(0);
  useFailedReadRepair(failure !== null, preparing, () => { setPreparing(true); retry(value => value + 1); });
  useEffect(() => {
    if (share.kind !== "Activity" || hasAdmitted || total === 0 || total > ADMIT_LIMIT) return;
    const scope = new AbortController();
    void (async () => {
      const files: File[] = [], unreadable: { name: string; sizeBytes: number | null }[] = [];
      for (const entry of share.entries) {
        const file = await readShared(`/_nexus/shared/${entry.index}`, scope.signal, async response => {
          if (response.status === 404) return null;
          if (response.status !== 200) { await readResponse(response); throw new ApiError(response.status, "E_INVALID_RESPONSE", "invalid native shared file response"); }
          return new File([await response.blob()], entry.name ?? "", { type: entry.type ?? "" });
        });
        if (file === null) unreadable.push({ name: entry.name ?? "", sizeBytes: entry.size });
        else files.push(file);
      }
      if (!scope.signal.aborted) { setPreparing(false); setFailure(null); admit({ links, files, unreadable, into: [] }); }
    })().catch(error => { if (!scope.signal.aborted) setFailure(error); })
      .finally(() => { if (!scope.signal.aborted) setPreparing(false); });
    return () => scope.abort();
  }, [admit, hasAdmitted, links, share, total, attempt]);
  const accepted = hasAdmitted && intake.lines.length > 0 && intake.lines.every(line => line.stage.kind === "Accepted");
  useEffect(() => { if (share.kind === "Activity" && accepted) window.location.assign("nexus-share://done"); }, [share, accepted]);
  if (intake.defect !== null) throw intake.defect.error;
  function press(line: IntakeLine, verb: ButtonVerb) {
    switch (verb.kind) {
      case "Retry": return intake.retry(line.id);
      case "RetryWithout": return intake.retryWithout(line.id);
      case "ChooseAgain": throw new Error("an expired shared upload retains its file");
      case "SignIn": return signIn();
      case "Reload": return window.location.reload();
      case "SeeWhy": case "AllImports": return window.location.assign(openPath(share, verb.target.href));
    }
  }
  return <>
    <h1 className={styles.heading}>import</h1>
    {total > ADMIT_LIMIT ? <Fact line={{ fact: `100 at a time. this has ${total}.` }} /> : null}
    {failure !== null ? <Failed error={failure} noun="shared files" retry={{ busy: preparing, run: () => { setPreparing(true); retry(value => value + 1); } }} />
      : preparing ? <Ruling /> : null}
    <div className={styles.results}>
      {!hasAdmitted && share.kind === "Manual" ? links.map(url => <div className={styles.pointer} key={url} title={url}>{linkPointer(url)}</div>) : null}
      {intake.lines.map(line => {
        const view = lineView(line);
        return <div className={styles.line} key={line.id}><ImportLine line={line} view={view} tabbable onVerb={verb => press(line, verb)}
          onDismiss={() => view.dismiss === "Stop" ? intake.stop(line.id) : intake.remove(line.id)} /></div>;
      })}
    </div>
    <div className={styles.actions}>
      {!hasAdmitted && share.kind === "Manual" ? <>
        <Button disabled={total === 0 || total > ADMIT_LIMIT} onClick={() => admit({ links, files: [], into: [] })}>
          {links.length > 1 ? `import ${links.length} links` : "import"}
        </Button>
        <a className={styles.action} href={APP_AUTHENTICATED_HOME_HREF}>cancel</a>
      </> : <a className={styles.action} href={donePath(share)}>done</a>}
    </div>
  </>;
}

const NOT_OPENED = "couldn’t open your notes on this device.";
function PlainShareAdmission({ text, share }: { text: string; share: Share }) {
  const transportVerbs = useTransportVerbs();
  const [account, setAccount] = useState<ShareAccount | null>(null);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [admissionDefect, setAdmissionDefect] = useState<{ error: unknown } | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      const binding = "nexusAuthored" in window ? (await readDeviceStartup())?.binding ?? null : await readBrowserBinding();
      if (!binding) throw new CaptureAdmissionError("Unbound");
      let capture: ShareAccount["capture"] = null;
      if (share.kind === "Activity") {
        const params = new URL(location.href).searchParams;
        if (params.get("capture_account_id") !== binding.account.account_id) throw new CaptureAdmissionError("OtherAccount");
        const noteId = params.get("capture_id"), localDate = params.get("capture_date");
        // the share shell writes these: a malformed one is our defect, not another account's share.
        if (noteId === null || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(noteId) || localDate === null || !isLocalDate(localDate)) throw new Error("share shell sent a malformed capture");
        capture = {noteId, localDate};
      }
      if (active) { setAccount({user_id:binding.account.account_id,calendar_time_zone:binding.account.calendar_time_zone,capture});setFailure(null); }
    })().catch(error => { if (!active) return; if (error instanceof CaptureAdmissionError || isAuthoredStorageFailure(error) || isApiError(error)) setFailure(error); else setAdmissionDefect({ error }); });
    return () => {active=false;};
  },[attempt,share]);
  // A failed read heals: a repair (focus, back online) reads again.
  useEffect(() => isApiError(failure) ? subscribeRepair(() => retry(value => value + 1)) : undefined, [failure]);
  useSyncExternalStore(subscribeAdmission, updateRemedy, updateRemedy);
  if (admissionDefect !== null) throw admissionDefect.error;
  const retryAdmission: CommandVerb = { label: "retry", commandKey: "RetryShareAdmission", run: () => retry(value => value + 1) };
  if (failure !== null) {
    if (failure instanceof CaptureAdmissionError) return failure.kind === "Unbound"
      ? <Fact line={{ fact: "your notes aren’t on this device yet.", reason: "open nexus once, then share again." }} verbs={[retryAdmission]} speak />
      : <Fact line={{ fact: "this share belongs to another account.", reason: "share again from the original app." }} speak />;
    if (!isApiError(failure)) return <Fact line={{ fact: NOT_OPENED }} verbs={[retryAdmission]} speak />;
    const transport = transportOf(failure);
    return <Fact line={TRANSPORT_LINES[transport].command(NOT_OPENED)} verbs={transportVerbs(transport, { retry: retryAdmission }) ?? undefined} speak />;
  }
  if (account === null) return <Ruling />;
  return <AuthoredProvider accountId={account.user_id} host="share" openWorkspace={() => window.location.assign(openPath(share, "/downloads"))}>
    <PlainShare text={text} share={share} account={account} />
  </AuthoredProvider>;
}

type CaptureResult = { ok: true; status: string; path: string } | { ok: false; local_commit: boolean; fact: string };
function PlainShare({ text, share, account }: { text: string; share: Share; account: ShareAccount }) {
  const trimmed = text.trim();
  const accountId = account.user_id, timeZone = account.calendar_time_zone;
  const captureNoteId = account.capture?.noteId ?? null, captureDate = account.capture?.localDate ?? null;
  const [started, setStarted] = useState(share.kind === "Activity");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const note = useRef<{ accountId: string; localDate: string; noteId: string; capture: Promise<boolean>; failure: LocalCommitError | null; committed: boolean; check: () => Promise<boolean>; run: () => Promise<boolean> } | null>(null);
  const sentAttempt = useRef<number | null>(null);
  const guard = useWorkGuard();
  useLayoutEffect(() => guard.register({ id: "share-submitted-capture", scope: { kind: "surface", id: "share" },
    subscribe: () => () => {},
    read: () => ({ changed: false, unconfirmed: saving, stopsBrowserWork: saving }),
  }), [guard, saving]);

  // One live attempt freezes its date, ids and text. Retries use its handle;
  // admission is never reported as a successful capture.
  useEffect(() => {
    if (!started) return;
    let active = true;
    const runtime = getWritingRuntime(accountId);
    if (note.current === null || note.current.accountId !== accountId) {
      const localDate = captureDate ?? formatLocalDateInTimeZone(new Date(), timeZone);
      const noteId = captureNoteId ?? crypto.randomUUID();
      const inspect = async (): Promise<boolean | null> => {
        const store = await runtime.store;
        const binding = await store.query({kind:"binding",key:{kind:"daily",local_date:localDate}});
        const pageRef = binding.binding_id ?? `page:${dailyId(accountId,localDate)}`;
        const noteRef = `note_block:${noteId}`;
        const relationId = linkId(accountId,pageRef,noteRef);
        const states = await store.readStates({refs:[noteRef,pageRef],link_ids:[relationId],anchor_ids:[],source_refs:[]});
        const existing = states.resources.find(resource => resource.ref === noteRef);
        if (!existing) return null;
        const page = states.resources.find(resource => resource.ref === pageRef);
        const link = states.links.find(resource => resource.link_id === relationId);
        return isVisible(existing.touch_vv,existing.delete_vv) && page !== undefined && isVisible(page.touch_vv,page.delete_vv) && link !== undefined && isVisible(link.add_vv,link.remove_vv);
      };
      const check = async () => {
        const available = await inspect();
        // justify-defect: even deletion retains a committed capture's authored tombstone.
        if (available === null) throw new Error("committed share capture is missing");
        return available;
      };
      const run = async () => {
        const existing = await inspect();
        if (existing !== null) return existing;
        await captureToday(runtime,localDate,noteId,trimmed);
        return true;
      };
      note.current = {accountId,localDate,noteId,capture:run(),failure:null,committed:false,check,run};
    } else if (sentAttempt.current !== attempt) {
      const current = note.current;
      if (current.failure) { current.capture = current.failure.retry().then(current.check); current.failure = null; }
      else current.capture = current.committed ? current.check() : current.run();
    }
    sentAttempt.current = attempt;
    const current = note.current;
    setSaving(true);
    const accepted = (available: boolean) => {
      current.committed=true;
      if(active && note.current===current)setResult({ok:true,status:available?`added to ${current.localDate}`:"removed since",path:`/daily/${current.localDate}`});
    };
    const failed = (error: unknown) => {
      if(error instanceof LocalCommitError) {
        current.failure=error;
        void error.completion.then(() => {
          current.failure=null; current.committed=true; current.capture=current.check();
          void current.capture.then(accepted, failed);
        }, () => {});
      } else if (!isAuthoredStorageFailure(error)) { if(active)setDefect({error}); return; }
      if(active)setResult({ok:false,local_commit:error instanceof LocalCommitError,
        fact:current.committed?"couldn’t check this note.":"this note isn’t saved yet."});
    };
    void current.capture.then(accepted, failed).finally(()=>{if(active)setSaving(false);});
    return()=>{active=false;};
  },[started,accountId,timeZone,attempt,trimmed,captureNoteId,captureDate]);

  if (defect !== null) throw defect.error;
  return <>
    <h1 className={styles.heading}>add to today</h1>
    <p className={styles.body}>{trimmed}</p>
    <div className={styles.actions}>
      {!started ? <>
        <Button onClick={() => { setSaving(true); setStarted(true); }}>add to today</Button>
        <a className={styles.action} href={APP_AUTHENTICATED_HOME_HREF}>cancel</a>
      </> : <>
        {result !== null && !result.ok ? <Button aria-busy={saving || undefined} disabled={saving}
          onClick={() => { setSaving(true); setAttempt(value => value + 1); }}>retry</Button> : null}
        {result?.ok ? <a className={styles.action} href={openPath(share, result.path)}>open</a> : null}
        <a className={styles.action} href={donePath(share)}>done</a>
      </>}
    </div>
    {result?.ok ? <Fact line={{ fact: result.status }} /> : result !== null && !result.local_commit ? <Fact line={{ fact: result.fact }} speak /> : null}
  </>;
}
