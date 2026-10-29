"use client";

// The Android share sheet's capture card (`/share?text=`). Links get their list,
// a destination field (create allowed) and Save; each link is saved under its
// own id, kept for the page's life, so Retry resends the same acceptance. Plain
// text is appended to today's daily note once per attempt, under a date and a
// note id fixed on first send. Results offer Open (in the shell, through
// `nexus-share://open`) and Done.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FeedbackBusy, FeedbackFailure, FeedbackProvider, FeedbackRecoveryControl, FeedbackState, FeedbackStatus, useFeedbackOccurrence, type FeedbackContent } from "@/components/feedback/Feedback";
import FeedbackSurface from "@/components/feedback/FeedbackSurface";
import Button from "@/components/ui/Button";
import DestinationField from "@/components/libraries/DestinationField";
import { setDestination } from "@/components/libraries/DestinationChooser";
import { createDestinationCreation, useDestinationCreation } from "@/components/libraries/useDestinationCreation";
import {
  isApiError,
  outcomeUnknown,
  isUnauthenticatedApiError,
} from "@/lib/api/client";
import { runBoundedTasks } from "@/lib/async/runBoundedTasks";
import { extractUrls } from "@/lib/extractUrls";
import { captureErrorFeedback, captureStatusLine } from "@/lib/imports/copy";
import { addMediaFromUrl } from "@/lib/imports/ingest";
import { acquisitionGuard, libraryDestinations, type AcquisitionGuard, type LibraryDestination } from "@/lib/libraries/api";
import { formatLocalDateInTimeZone, isLocalDate } from "@/lib/localDate";
import { dailyId, linkId } from "@nexus/authored/identity";
import { isVisible } from "@nexus/authored/merge";
import { captureToday } from "@/lib/notes/api";
import { getWritingRuntime, isAuthoredStorageFailure, LocalCommitError } from "@/lib/notes/runtime";
import { AuthoredProvider } from "@/lib/authored/provider";
import { readBrowserBinding } from "@/lib/authored/binding";
import { readDeviceStartup } from "@/lib/native/client";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";
import { WorkProvider, useWorkGuard } from "@/lib/unsavedWork";
import styles from "./share.module.css";

type Result =
  | { label: string; ok: true; status: string; path: string; available: boolean }
  | { label: string; ok: false; retryable: boolean; review: boolean; local_commit: boolean; feedback: FeedbackContent };

/** A refusal as a result row: sign-out is final for this share; anything the
    surface does not model throws. */
function failed(
  label: string,
  error: unknown,
  describe: () => FeedbackContent | null,
): Extract<Result, { ok: false }> {
  if (isUnauthenticatedApiError(error)) {
    const feedback: FeedbackContent = {
      tone: "Danger",
      title: "Sign in to save this",
      message: "Open Nexus, sign in, then share again.",
      requestId: error.requestId,
    };
    return { label, ok: false, retryable: false, review: false, local_commit: false, feedback };
  }
  const feedback = describe();
  if (feedback === null) throw error;
  return { label, ok: false, retryable: true, local_commit: false, review: isApiError(error) && ["E_RESOURCE_CONFLICT", "E_LIBRARY_FORBIDDEN"].includes(error.code), feedback };
}

class CaptureAdmissionError extends Error {}
type ShareAccount = { user_id: string; calendar_time_zone: string; capture: {noteId: string; localDate: string} | null };
export default function ShareCapture(props: { text: string; isShell: boolean }) {
  const [bounds, setBounds] = useState<HTMLDivElement | null>(null);
  return <FeedbackProvider><div ref={setBounds} className={styles.capture}>
    <FeedbackSurface bounds={bounds} interaction={null} modal={null} active
      protectedTargets={() => bounds ? [...bounds.querySelectorAll<HTMLElement>("[data-feedback-controls]")] : []} returnFocus={() => bounds}>
      <span className={styles.recoverySlot} data-feedback-controls="true"><FeedbackRecoveryControl /></span>
      <ShareCaptureAdmission {...props} />
    </FeedbackSurface>
  </div></FeedbackProvider>;
}
function ShareCaptureAdmission(props: { text: string; isShell: boolean }) {
  const plain = props.text.trim() !== "" && extractUrls(props.text).length === 0;
  const [account, setAccount] = useState<ShareAccount | null>(null);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [admissionDefect, setAdmissionDefect] = useState<{ error: unknown } | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!plain) return;
    let active = true;
    void (async () => {
      const binding = "nexusAuthored" in window ? (await readDeviceStartup())?.binding ?? null : await readBrowserBinding();
      if (!binding) throw new CaptureAdmissionError("open nexus once to prepare your notes on this device, then share again.");
      let capture: ShareAccount["capture"] = null;
      if (props.isShell) {
        const params = new URL(location.href).searchParams;
        const noteId = params.get("capture_id"), localDate = params.get("capture_date");
        if (params.get("capture_account_id") !== binding.account.account_id || noteId === null || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(noteId) || localDate === null || !isLocalDate(localDate)) throw new CaptureAdmissionError("this capture no longer belongs to the account open on this device. share again from the original app.");
        capture = {noteId, localDate};
      }
      if (active) { setAccount({user_id:binding.account.account_id,calendar_time_zone:binding.account.calendar_time_zone,capture});setFailure(null); }
    })().catch(error => { if (!active) return; if (error instanceof CaptureAdmissionError || isAuthoredStorageFailure(error) || isApiError(error)) setFailure(error); else setAdmissionDefect({ error }); });
    return () => {active=false;};
  },[plain,attempt,props.isShell]);
  if (admissionDefect !== null) throw admissionDefect.error;
  if (plain && failure) return <FeedbackState content={{tone:"Warning",title:"couldn’t open notes on this device",message:failure instanceof CaptureAdmissionError?failure.message:"open nexus and try sharing again."}} announcement="Polite" actions={[{label:"retry",onClick:()=>retry(value=>value+1)}]} />;
  if (plain && !account) return <FeedbackBusy pending />;
  return <WorkProvider>{plain && account ? <AuthoredProvider accountId={account.user_id} host="share"><ShareCaptureContent {...props} account={account} /></AuthoredProvider> : <ShareCaptureContent {...props} account={null} />}</WorkProvider>;
}

function ShareCaptureContent({
  text,
  isShell,
  account,
}: {
  text: string;
  isShell: boolean;
  account: ShareAccount | null;
}) {
  const trimmed = text.trim();
  const urls = useMemo(() => extractUrls(trimmed), [trimmed]);
  const [results, setResults] = useState<Result[] | null>(null);
  const resultArea = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);
  const [destinationCreation] = useState(createDestinationCreation);
  const creation = useDestinationCreation(trimmed, destinationCreation);
  const creating = creation.creating;
  const [destinations, setDestinations] = useState<
    readonly LibraryDestination[]
  >([]);
  const [attempt, setAttempt] = useState(0);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const commands = useRef(new Map<string, { id: string; guard: AcquisitionGuard;unconfirmed:boolean }>());
  const [reviewUrls, setReviewUrls] = useState<readonly string[] | null>(null);
  const note = useRef<{ accountId: string; localDate: string; noteId: string; capture: Promise<boolean>; failure: LocalCommitError | null; committed: boolean; check: () => Promise<boolean>; run: () => Promise<boolean> } | null>(null);
  const sentAttempt = useRef<number | null>(null);
  const plainText = trimmed !== "" && urls.length === 0;
  const timeZone = account?.calendar_time_zone ?? null;
  const accountId = account?.user_id ?? null;
  const captureNoteId = account?.capture?.noteId ?? null;
  const captureDate = account?.capture?.localDate ?? null;
  const guard = useWorkGuard();


  useLayoutEffect(()=>guard.register({id:"share-submitted-acquisition",scope:{kind:"surface",id:"share"},
    subscribe:destinationCreation.subscribe,
    read:()=>({changed:false,unconfirmed:saving||destinationCreation.readUnconfirmed()||[...commands.current.values()].some(command=>command.unconfirmed),stopsBrowserWork:saving||creating}),
  }),[guard,destinationCreation,saving,creating,results]);

  // One live attempt freezes its date, ids and text. Retries use its handle;
  // admission is never reported as a successful capture.
  useEffect(() => {
    if (!plainText || accountId === null || timeZone === null) return;
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
      if(active && note.current===current)setResults([{label:trimmed,ok:true,available,status:available?`saved to ${current.localDate}`:"this item was saved, then removed",path:`/daily/${current.localDate}`}]);
    };
    const failed = (error: unknown) => {
      if(error instanceof LocalCommitError) {
        current.failure=error;
        void error.completion.then(() => {
          current.failure=null; current.committed=true; current.capture=current.check();
          void current.capture.then(accepted, failed);
        }, () => {});
      } else if (!isAuthoredStorageFailure(error)) { if(active)setDefect({error}); return; }
      if(active)setResults([{label:trimmed,ok:false,retryable:true,review:false,local_commit:error instanceof LocalCommitError,
        feedback:{tone:"Warning",title:current.committed?"couldn’t check this capture":"couldn’t save on this device",message:current.committed?"retry checking the saved note.":"keep this page open. retry saving."}}]);
    };
    void current.capture.then(accepted, failed).finally(()=>{if(active)setSaving(false);});
    return()=>{active=false;};
  },[plainText,accountId,timeZone,attempt,trimmed,captureNoteId,captureDate]);

  if (defect !== null) throw defect.error;

  async function saveUrl(url: string): Promise<Result> {
    const command = commands.current.get(url);
    if (command === undefined) throw new Error("share submission has no frozen acquisition command");
    try {
      command.unconfirmed=true;
      const accepted = await addMediaFromUrl({ url,id:command.id,guard:command.guard });
      command.unconfirmed=false;
      return {
        label: url,
        ok: true,
        available: accepted.available,
        status: captureStatusLine(accepted),
        path: accepted.href,
      };
    } catch (error) {
      command.unconfirmed=outcomeUnknown(error);
      if (isApiError(error) && error.status >= 400 && error.status < 500 && error.status !== 401) commands.current.delete(url);
      return failed(url, error, () =>
        captureErrorFeedback(error, "SaveSource"),
      );
    }
  }

  async function save(targets: readonly string[]): Promise<void> {
    if (saving || creating) return;
    setSaving(true);
    setReviewUrls(null);
    try {
      if (targets.some(url => !commands.current.has(url))) {
        const snapshot = await libraryDestinations();
        for (const url of targets) if (!commands.current.has(url)) commands.current.set(url, { id: crypto.randomUUID(), guard: acquisitionGuard(destinations, snapshot.removal_revision),unconfirmed:false });
      }
    } catch (error) {
      setResults(targets.map(url => failed(url, error, () => captureErrorFeedback(error, "SaveSource"))));
      setSaving(false);
      return;
    }
    runBoundedTasks({ items: targets, concurrency: 2, run: saveUrl })
      .then((outcomes) => {
        const settled = outcomes.map((outcome) => {
          if (outcome.kind === "Rejected") throw outcome.error;
          return outcome.value;
        });
        setResults((current) =>
          current === null
            ? settled
            : current.map(
                (result) =>
                  settled.find((next) => next.label === result.label) ?? result,
              ),
        );
      })
      .catch((error: unknown) => setDefect({ error }))
      .finally(() => setSaving(false));
  }

  const retry = (result: Result) => {
    if (saving) return;
  if (urls.length > 0 && !result.ok && result.review) {
      setSaving(true);
      void libraryDestinations().then(snapshot => {
        const current = new Map(snapshot.destinations.map(destination => [destination.id, destination]));
        setDestinations(selected => selected.map(destination => current.get(destination.id) ?? destination));
        setReviewUrls([result.label]);
      }, error => setDefect({ error })).finally(() => setSaving(false));
    } else if (urls.length > 0) void save([result.label]);
    else {
      setSaving(true);
      setAttempt((n) => n + 1);
    }
  };
  const done = isShell ? "nexus-share://done" : APP_AUTHENTICATED_HOME_HREF;
  const open = (path: string) =>
    isShell ? `nexus-share://open?path=${encodeURIComponent(path)}` : path;

  if (trimmed === "") {
    return (
      <>
        <h1 className={styles.heading}>Nothing to share</h1>
        <p className={styles.body}>
          The shared text was empty, so there was nothing to save.
        </p>
        <div className={styles.actions}>
          <a className={styles.actionPrimary} href={done}>
            Done
          </a>
        </div>
      </>
    );
  }

  if (plainText) {
    const result = results?.[0] ?? null;
    return <>
      <h1 className={styles.heading}>save to nexus</h1>
      <p className={styles.body}>{trimmed}</p>
      <div className={styles.actions}>
        <Button reserveIcon aria-busy={saving || undefined} disabled={saving || result === null || result.ok || !result.retryable}
          onClick={() => { if (result !== null) retry(result); }}>save</Button>
        {result?.ok ? <a className={styles.actionPrimary} href={open(result.path)}>open</a> : null}
        <a className={styles.action} href={done}>done</a>
      </div>
      {result !== null && !result.ok && !result.local_commit ? <CaptureFailure result={result} saving={saving} retry={() => retry(result)} /> : null}
      {result?.ok ? <FeedbackStatus content={{ tone: "Neutral", title: result.status }} announcement="None" /> : null}
    </>;
  }

  if (urls.length > 0 && (results === null || reviewUrls !== null || results.some(result => !result.ok))) {
    return (
      <>
        <h1 className={styles.heading}>Save to Nexus</h1>
        <div className={styles.results}>
          {urls.map((url) => (
            <div key={url} className={styles.resultItem}>
              <span className={styles.resultLabel} title={url}>
                {url}
              </span>
            </div>
          ))}
        </div>
        <DestinationField
          context={trimmed}
          label="Library destinations"
          emptyLabel="No additional libraries"
          chosen={destinations}
          onSet={change => {
            if (saving) return false;
            setDestinations(current => setDestination(current, change));
            return true;
          }}
          disabled={saving}
          create={{ available: !saving, pendingNames: creation.pendingNames,
            onCreate: name => creation.admit({ name, scope: trimmed,
              onCreated: destination => setDestinations(current => setDestination(current, { destination, included: true })),
            }) }}
          error={creation.error}
        />
        {results?.filter((result): result is Extract<Result, { ok: false }> => !result.ok).map(result => <CaptureFailure key={result.label} result={result} saving={saving} retry={() => retry(result)} />)}
        <div className={styles.actions}>
          <Button reserveIcon
            className={styles.actionPrimary}
            aria-busy={saving || undefined}
            disabled={creating || saving}
            onClick={() => void save(reviewUrls ?? urls)}
          >
            Save
          </Button>
          <a
            className={styles.action}
            href={
              isShell ? "nexus-share://dismiss" : APP_AUTHENTICATED_HOME_HREF
            }
          >
            Cancel
          </a>
        </div>
      </>
    );
  }

  const shown =
    results;
  if (shown === null) {
    return (
      <>
        <FeedbackBusy pending />
      </>
    );
  }

  const anySaved = shown.some((result) => result.ok && result.available);
  const signedOut = shown.some((result) => !result.ok && result.feedback.title === "Sign in to save this");
  return (
    <>
      <h1 className={styles.heading}>
        {anySaved
          ? "Saved to Nexus"
          : shown.some(result => result.ok) ? "this item was saved, then removed"
          : signedOut
            ? "Sign in to save this"
            : "Couldn’t save"}
      </h1>
      <div className={styles.results} ref={resultArea} tabIndex={-1}>
        {shown.map((result) => (
          <div key={result.label} className={styles.resultItem}>
            <span className={styles.resultLabel} title={result.label}>
              {result.label}
            </span>
            {result.ok ? (
              <FeedbackStatus
                content={{ tone: "Neutral", title: result.status }}
                announcement="Polite"
                actions={result.available ? [{ label: result.path.startsWith("/daily/") ? "open" : "open in nexus", href: open(result.path) }] : undefined}
              />
            ) : (
              <CaptureFailure result={result} saving={saving} retry={() => retry(result)} />
            )}
          </div>
        ))}
      </div>
      <div className={styles.actions}>
        <a
          className={anySaved ? styles.actionPrimary : styles.action}
          href={done}
        >
          Done
        </a>
      </div>
    </>
  );
}

function CaptureFailure({ result, saving, retry }: { result: Extract<Result, { ok: false }>; saving: boolean; retry: () => void }) {
  const occurrence = useFeedbackOccurrence(true, result.label);
  return <FeedbackFailure scope="Local" occurrence={occurrence} content={result.feedback} announcement="Polite"
    actions={result.retryable ? [{ label: result.review ? "review and save" : "retry same save", onClick: retry, busy: saving }] : undefined} />;
}
