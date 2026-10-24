"use client";

// Library settings, opened by id: rename (sent with the name it replaces) and
// delete (owner only, confirmed). Deleting a library never deletes media: items
// filed only there move to the owner's All. Membership lives in the Members tab.

import { useLayoutEffect, useRef } from "react";
import { FeedbackNotice, FeedbackState, FieldFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { isRefusal } from "@/lib/api/client";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import { unstamped } from "@/lib/consumption/listening";
import { deleteLibrary, getLibrary, renameLibrary } from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { libraryNameError } from "@/lib/libraries/views";
import { useLatestWorkspace } from "@/lib/workspace/store";
import styles from "./LibrarySettingsDialog.module.css";

interface SettingsDraft {
  draft: string | null;
  baseline: string | null;
  /** `unconfirmed`: an earlier send of this request ended without an answer that settles it. */
  request: { name: string; rawDraft: string | null; expectedName: string; unconfirmed: boolean } | null;
  busy: "Rename" | "Delete" | null;
  confirming: boolean;
  deleted: boolean;
  feedback: FeedbackContent | null;
}

export default function LibrarySettingsDialog({
  libraryId,
  onClose,
}: {
  readonly libraryId: string;
  readonly onClose: () => void;
}) {
  const fail = useThrowLater();
  const { ctx } = useActionRuntime();
  const contentRef = useRef<HTMLDivElement>(null);
  const workspace = useLatestWorkspace();
  const rawLibrary = usePaneFreeServerValue({
    key: `/libraries/${libraryId}`,
    stale: useChangeStamp("Libraries"),
    load: (signal) => getLibrary(libraryId, signal),
  });
  const library = unstamped(rawLibrary);
  const current = library.status === "ready" ? library.data : null;
  const guard = useWorkGuard();
  const state = useResourceDraft<SettingsDraft>(`LibrarySettings:${libraryId}`, () => ({
    draft: null,
    baseline: null,
    request: null,
    busy: null,
    confirming: false,
    deleted: false,
    feedback: null,
  }), value => ({
    changed: value.draft !== null && value.draft !== value.baseline,
    unconfirmed: value.request !== null || value.busy === "Delete",
    stopsBrowserWork: false,
  }));
  const { draft, baseline, busy, confirming, feedback, deleted } = state.value;
  const setBusy = (busy: "Rename" | "Delete" | null) => state.set(value => ({ ...value, busy }));
  const setFeedback = (feedback: FeedbackContent | null) => state.set(value => ({ ...value, feedback }));
  const setConfirming = (confirming: boolean) => state.set(value => ({ ...value, confirming }));
  const { read: readSettings, set: writeSettings } = state;
  useLayoutEffect(() => {
    if (current === null) return;
    const value = readSettings();
    if (value.request === null && (value.draft === null || value.draft === value.baseline))
      writeSettings({ ...value, draft: current.name, baseline: current.name });
  }, [current, readSettings, writeSettings]);
  const requestDismiss = () => guard.confirmLoss({ scopes: [], ownerIds: [state.owner] }) ? "accepted" as const : "blocked" as const;

  if (current === null) {
    const failure =
      library.status === "failed"
        ? libraryErrorFeedback(library.error, "Library settings couldn’t be loaded", throwDefect)
        : null;
    return (
      <Dialog open onClose={onClose} onDismissRequest={requestDismiss} title="Library settings">
        {draft !== null ? <><Input aria-label="unsaved library name" value={draft} readOnly />
          <p>this library is unavailable. your unsaved name remains available to copy.</p></> : null}
        {failure ? (
          <FeedbackNotice
            content={failure}
            announcement="Assertive"
            actions={[{ label: "retry", onClick: library.refetch, busy: library.status === "failed" && library.retrying }]}
            returnFocus={() => contentRef.current}
          />
        ) : (
          <FeedbackState content={{ tone: "Neutral", title: "loading library settings…" }} announcement="Polite" />
        )}
      </Dialog>
    );
  }

  const name = (draft ?? current.name).trim();
  const invalid = libraryNameError(name);
  // A request in flight keeps the verb it was sent under; only an unconfirmed one offers a retry.
  const renameRequest = state.value.request;
  const renameLabel = renameRequest?.unconfirmed ? "retry same request"
    : (renameRequest ? renameRequest.expectedName !== baseline : baseline !== current.name) ? "save my name" : "Save";
  const rename = async () => {
    const value = state.read();
    const signal = ctx.sessionSignal();
    const request = value.request ?? { name, rawDraft: value.draft, expectedName: current.name !== baseline ? current.name : baseline, unconfirmed: false };
    state.set({ ...value, request, busy: "Rename", feedback: null });
    try {
      const saved = await renameLibrary(libraryId, request.name, request.expectedName);
      if (signal.aborted) return;
      state.set(latest => ({ ...latest, request: null, busy: null, baseline: saved.name,
        draft: latest.draft === request.rawDraft ? saved.name : latest.draft }));
    } catch (error) {
      if (signal.aborted) return;
      state.set(latest => ({ ...latest, busy: null,
        request: isRefusal(error) && value.request === null ? null : { ...request, unconfirmed: true },
        feedback: libraryErrorFeedback(error, "Library name wasn’t saved", fail) }));
      library.refetch();
    }
  };
  const remove = async () => {
    const signal = ctx.sessionSignal();
    setBusy("Delete");
    setFeedback(null);
    try {
      await deleteLibrary(libraryId);
      if (signal.aborted) return;
      settleDeletedResourcePanes({
        workspace: workspace(),
        deletedRef: `library:${libraryId}`,
        fallbackHref: "/libraries",
      });
      state.set(value => ({ ...value, busy: null, deleted: true,
        feedback: { tone: "Warning", title: "this library was deleted", message: "your unsaved name remains available to copy." } }));
      if (state.read().draft === state.read().baseline && state.read().request === null) onClose();
    } catch (error) {
      if (signal.aborted) return;
      setFeedback(libraryErrorFeedback(error, "Library couldn’t be deleted", fail));
      setBusy(null);
    }
  };

  return (
    <Dialog open onClose={onClose} onDismissRequest={requestDismiss} title="Library settings">
      <div className={styles.sections} ref={contentRef} tabIndex={-1}>
        {feedback ? <FeedbackNotice content={feedback} announcement="Assertive" /> : null}
        <section className={styles.section}>
          <label htmlFor={`library-name-${libraryId}`}>Library name</label>
          {baseline !== current.name && draft !== baseline ? <p>current library name: {current.name}</p> : null}
          <div className={styles.row}>
            <Input
              id={`library-name-${libraryId}`}
              value={draft ?? current.name}
              readOnly={deleted}
              disabled={!current.can_manage || busy !== null}
              aria-invalid={invalid !== null || undefined}
              aria-describedby={invalid ? `library-name-error-${libraryId}` : undefined}
              onChange={(event) => state.set(value => ({ ...value, draft: event.target.value }))}
            />
            {current.can_manage && !deleted ? (
              <Button
                emphasis="strong"
                aria-busy={busy === "Rename" || undefined}
                disabled={invalid !== null || renameRequest === null && name === baseline || busy !== null}
                onClick={() => void rename()}
              >
                {renameLabel}
              </Button>
            ) : null}
          </div>
          {invalid ? (
            <FieldFeedback id={`library-name-error-${libraryId}`} content={{ tone: "Warning", title: invalid }} />
          ) : null}
        </section>
        {current.can_delete && !deleted ? (
          <section className={styles.danger}>
            <h3>Delete library</h3>
            <p>
              Deletes “{current.name}” for every member. Items filed only here move to
              your All; nothing else is deleted.
            </p>
            {confirming ? (
              <div className={styles.row}>
                <Button
                  emphasis="strong"
                  tone="danger"
                  aria-busy={busy === "Delete" || undefined}
                  disabled={busy !== null}
                  onClick={() => void remove()}
                >
                  Delete library
                </Button>
                <Button
                  disabled={busy !== null}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button tone="danger" onClick={() => setConfirming(true)}>
                Delete library…
              </Button>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
