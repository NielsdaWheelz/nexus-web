"use client";

// The Android share sheet's capture card (`/share?text=`). Links get their list,
// a destination field (create allowed) and Save; each link is saved under its
// own id, kept for the page's life, so Retry resends the same acceptance. Plain
// text is appended to today's daily note once per attempt, under a date and a
// note id fixed on first send. Results offer Open (in the shell, through
// `nexus-share://open`) and Done.

import { useEffect, useMemo, useRef, useState } from "react";
import { FeedbackNotice, FeedbackState, FeedbackStatus, type FeedbackContent } from "@/components/feedback/Feedback";
import DestinationField from "@/components/libraries/DestinationField";
import { setDestination } from "@/components/libraries/DestinationChooser";
import { createDestinationCreation, useDestinationCreation } from "@/components/libraries/useDestinationCreation";
import {
  isApiError,
  isUnauthenticatedApiError,
} from "@/lib/api/client";
import { runBoundedTasks } from "@/lib/async/runBoundedTasks";
import { extractUrls } from "@/lib/extractUrls";
import { captureErrorFeedback, captureStatusLine } from "@/lib/imports/copy";
import { addMediaFromUrl } from "@/lib/imports/ingest";
import { acquisitionGuard, libraryDestinations, type AcquisitionGuard, type LibraryDestination } from "@/lib/libraries/api";
import { formatLocalDateInTimeZone } from "@/lib/localDate";
import { captureToday } from "@/lib/notes/api";
import { getWritingRuntime, LocalCommitError } from "@/lib/notes/runtime";
import { AuthoredProvider } from "@/lib/authored/provider";
import { readBrowserBinding } from "@/lib/authored/binding";
import { readDeviceStartup } from "@/lib/native/client";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import { APP_AUTHENTICATED_HOME_HREF } from "@/lib/routes/defaults";
import { WorkProvider, useWorkGuard } from "@/lib/unsavedWork";
import styles from "./share.module.css";

type Result =
  | { label: string; ok: true; status: string; path: string; available: boolean }
  | { label: string; ok: false; retryable: boolean; review: boolean; feedback: FeedbackContent };

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
    return { label, ok: false, retryable: false, review: false, feedback };
  }
  const feedback = describe();
  if (feedback === null) throw error;
  return { label, ok: false, retryable: true, review: isApiError(error) && ["E_RESOURCE_CONFLICT", "E_LIBRARY_FORBIDDEN"].includes(error.code), feedback };
}

type ShareAccount = { user_id: string; calendar_time_zone: string };
export default function ShareCapture(props: { text: string; isShell: boolean }) {
  const plain = props.text.trim() !== "" && extractUrls(props.text).length === 0;
  const [account, setAccount] = useState<ShareAccount | null>(null);
  const [failure, setFailure] = useState<unknown | null>(null);
  const [attempt, retry] = useState(0);
  useEffect(() => {
    if (!plain) return;
    let active = true;
    void (async () => {
      const binding = "nexusAuthored" in window ? (await readDeviceStartup())?.binding ?? null : await readBrowserBinding();
      if (!binding) throw new Error("open nexus once to prepare your notes on this device, then share again.");
      if (active) { setAccount({user_id:binding.account.account_id,calendar_time_zone:binding.account.calendar_time_zone});setFailure(null); }
    })().catch(error => {if(active)setFailure(error);});
    return () => {active=false;};
  },[plain,attempt]);
  if (plain && failure) return <FeedbackState content={{tone:"Warning",title:"couldn’t open notes on this device",message:failure instanceof Error?failure.message:"open nexus and try again."}} announcement="Polite" actions={[{label:"retry",onClick:()=>retry(value=>value+1)}]} />;
  if (plain && !account) return <FeedbackState content={{tone:"Neutral",title:"opening your notes…"}} announcement="None" />;
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
  const commands = useRef(new Map<string, { id: string; guard: AcquisitionGuard }>());
  const [reviewUrls, setReviewUrls] = useState<readonly string[] | null>(null);
  const note = useRef<{ accountId: string; localDate: string; noteId: string; capture: Promise<string>; failure: LocalCommitError | null } | null>(null);
  const sentAttempt = useRef<number | null>(null);
  const plainText = trimmed !== "" && urls.length === 0;
  const timeZone = account?.calendar_time_zone ?? null;
  const accountId = account?.user_id ?? null;
  const guard = useWorkGuard();
  useEffect(() => {
    if (!accountId) return;
    const runtime = getWritingRuntime(accountId);
    return guard.register({id:`share-writing:${accountId}`,scope:{kind:"account"},subscribe:runtime.subscribe,read:()=>({changed:runtime.snapshot().saving||runtime.snapshot().error!==null,unconfirmed:false,stopsBrowserWork:false})});
  },[accountId,guard]);

  // One live attempt freezes its date, ids and text. Retries use its handle;
  // admission is never reported as a successful capture.
  useEffect(() => {
    if (!plainText || accountId === null || timeZone === null) return;
    let active = true;
    const runtime = getWritingRuntime(accountId);
    if (note.current === null || note.current.accountId !== accountId) {
      const localDate = formatLocalDateInTimeZone(new Date(), timeZone);
      const noteId = crypto.randomUUID();
      note.current = {accountId,localDate,noteId,capture:captureToday(runtime,localDate,noteId,trimmed),failure:null};
    } else if (sentAttempt.current !== attempt && note.current.failure) {
      note.current.capture = note.current.failure.retry().then(() => "");
      note.current.failure = null;
    }
    sentAttempt.current = attempt;
    const current = note.current;
    setSaving(true);
    void current.capture.then(() => {
      if(active)setResults([{label:trimmed,ok:true,available:true,status:`saved to ${current.localDate}`,path:`/daily/${current.localDate}`}]);
    }, (error:unknown) => {
      if(error instanceof LocalCommitError)current.failure=error;
      if(active)setResults([{label:trimmed,ok:false,retryable:error instanceof LocalCommitError,review:false,feedback:{tone:"Warning",title:"couldn’t save on this device",message:"keep this page open. retry saving."}}]);
    }).finally(()=>{if(active)setSaving(false);});
    return()=>{active=false;};
  },[plainText,accountId,timeZone,attempt,trimmed]);

  if (defect !== null) throw defect.error;

  async function saveUrl(url: string): Promise<Result> {
    const command = commands.current.get(url);
    if (command === undefined) throw new Error("share submission has no frozen acquisition command");
    try {
      const accepted = await addMediaFromUrl({ url, ...command });
      return {
        label: url,
        ok: true,
        available: accepted.available,
        status: captureStatusLine(accepted),
        path: accepted.href,
      };
    } catch (error) {
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
        for (const url of targets) if (!commands.current.has(url)) commands.current.set(url, { id: crypto.randomUUID(), guard: acquisitionGuard(destinations, snapshot.removal_revision) });
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

  if (urls.length > 0 && (results === null || reviewUrls !== null) && !saving) {
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
          status={creation.status}
        />
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.actionPrimary}
            disabled={creating}
            onClick={() => void save(reviewUrls ?? urls)}
          >
            Save
          </button>
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
        <FeedbackState content={{ tone: "Neutral", title: "saving…", message: "capturing what you shared." }} announcement="Polite" />
      </>
    );
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
  const anySaved = shown.some((result) => result.ok && result.available);
  const signedOut = shown.some((result) => !result.ok && result.feedback.title === "Sign in to save this");
  const captureFailed = note.current?.failure !== null;
  const copyCapture = () => {
    void copyText(trimmed).catch((error: unknown) => {
      if (!(error instanceof ClipboardWriteUnavailableError)) { setDefect({ error }); return; }
      setResults([{ label: trimmed, ok: false, retryable: false, review: false,
        feedback: { tone: "Warning", title: "copy unavailable", message: "select the shared text and copy it before leaving." } }]);
    });
  };
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
              <FeedbackNotice
                content={result.feedback}
                announcement="Assertive"
                actions={result.retryable ? [{ label: result.review ? "review and save" : "retry same save", onClick: () => retry(result), busy: saving }]
                  : plainText && captureFailed ? [{ label: "copy text", onClick: copyCapture }] : undefined}
                returnFocus={() => resultArea.current}
              />
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
