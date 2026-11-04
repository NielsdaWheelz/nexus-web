"use client";

// Library settings, opened by id: rename (sent with the name it replaces) and
// delete (owner only, confirmed). Deleting a library never deletes media: items
// filed only there move to the owner's All. Membership lives in the Members tab.
// A refused first send speaks once, an unsent one included. An unknown outcome holds in this
// dialog with its resend; a resend that fails, refused or unsent, holds again, since the first
// send may have landed. An acknowledgement settles it; an unavailable read leaves its
// recovery and loss guard intact. An unanswered command excludes the other kind.
// The draft name survives all of it.

import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { useLayoutEffect } from "react";
import { Fact, Failed, Field } from "@/components/feedback/Fact";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Ruling } from "@/components/feedback/Ruling";
import type { CommandVerb } from "@/components/feedback/stage";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { useActionRuntime } from "@/lib/actions/ResourceActionsProvider";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { isApiError, isSameSystemApiDefect, outcomeUnknown } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useWorkGuard } from "@/lib/unsavedWork";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import { unstamped } from "@/lib/consumption/listening";
import { deleteLibrary, getLibrary, renameLibrary } from "@/lib/libraries/api";
import { NAME_REFUSED, refuseLibrary } from "@/lib/libraries/errors";
import { libraryNameError } from "@/lib/libraries/views";
import { useLatestWorkspace } from "@/lib/workspace/store";
import styles from "./LibrarySettingsDialog.module.css";

/** A command whose outcome is unknown: which one, and its failed attempts. */
type Unconfirmed = { command: "Rename" | "Delete"; attempt: number };

interface SettingsDraft {
  draft: string | null;
  baseline: string | null;
  /** `unconfirmed`: an earlier send of this request ended without an answer that settles it. */
  request: { name: string; rawDraft: string | null; expectedName: string; unconfirmed: boolean } | null;
  busy: "Rename" | "Delete" | null;
  confirming: boolean;
  /** The delete endpoint acknowledged the operation, including invisible absence. */
  deleted: boolean;
  unknown: Unconfirmed | null;
  /** The name the server refused as invalid, while the draft still says it. */
  refusedName: string | null;
}

export default function LibrarySettingsDialog({
  libraryId,
  onClose,
}: {
  readonly libraryId: string;
  readonly onClose: () => void;
}) {
  const fail = useThrowLater();
  const outcome = useOutcome();
  const resendFeedback = useResendFeedback();
  const { ctx } = useActionRuntime();
  const workspace = useLatestWorkspace();
  const rawLibrary = usePaneFreeServerValue({
    key: `/libraries/${libraryId}`,
    stale: useChangeStamp("Libraries"),
    load: (signal) => getLibrary(libraryId, signal),
  });
  const library = unstamped(rawLibrary);
  const guard = useWorkGuard();
  const state = useResourceDraft<SettingsDraft>(`LibrarySettings:${libraryId}`, () => ({
    draft: null,
    baseline: null,
    request: null,
    busy: null,
    confirming: false,
    deleted: false,
    unknown: null,
    refusedName: null,
  }), value => ({
    changed: value.draft !== null && value.draft !== value.baseline,
    unconfirmed: value.request !== null || value.busy === "Delete" || value.unknown?.command === "Delete",
    stopsBrowserWork: false,
  }));
  const { draft, baseline, busy, confirming, deleted, unknown } = state.value;
  const gone = !deleted && library.status !== "loading" && library.error?.status === 404;
  const current = library.status === "ready" && !gone ? library.data : null;
  const setBusy = (busy: "Rename" | "Delete" | null) => state.set(value => ({ ...value, busy }));
  const setConfirming = (confirming: boolean) => state.set(value => ({ ...value, confirming }));
  /** Records an unknown outcome; a defect goes to the boundary instead. */
  const unconfirmed = (error: unknown, command: Unconfirmed["command"]) => {
    if (!isApiError(error) || isSameSystemApiDefect(error)) { fail({ error }); return null; }
    return (previous: Unconfirmed | null): Unconfirmed => ({ command, attempt: previous?.command === command ? previous.attempt + 1 : 0 });
  };
  const { read: readSettings, set: writeSettings } = state;
  useLayoutEffect(() => {
    const value = readSettings();
    if (current !== null && value.request === null && (value.draft === null || value.draft === value.baseline))
      writeSettings({ ...value, draft: current.name, baseline: current.name });
  }, [current, readSettings, writeSettings]);
  const requestDismiss = () => guard.confirmLoss({ scopes: [], ownerIds: [state.owner] }) ? "accepted" as const : "blocked" as const;

  const rename = async () => {
    const value = state.read();
    if (value.busy !== null || value.unknown?.command === "Delete") return;
    const request = value.request ?? (current === null ? null : {
      name: (value.draft ?? current.name).trim(), rawDraft: value.draft,
      expectedName: current.name !== value.baseline ? current.name : value.baseline, unconfirmed: false,
    });
    if (request === null) return;
    const fact = current === null ? "couldn’t rename this library." : `couldn’t rename “${current.name}”.`;
    const signal = ctx.sessionSignal();
    state.set({ ...value, request, busy: "Rename" });
    try {
      const saved = await renameLibrary(libraryId, request.name, request.expectedName);
      if (signal.aborted) return;
      state.set(latest => ({ ...latest, request: null, busy: null, baseline: saved.name, unknown: null,
        draft: latest.draft === request.rawDraft ? saved.name : latest.draft }));
    } catch (error) {
      if (signal.aborted) return;
      handleUnauthenticatedApiError(error);
      // A refusal settles a first send; after an unknown one it can't say whether that landed.
      if (!outcomeUnknown(error) && value.request === null) {
        const invalid = isApiError(error) && error.code === "E_NAME_INVALID";
        state.set(latest => ({ ...latest, busy: null, request: null, refusedName: invalid ? request.name : latest.refusedName }));
        if (!invalid) refuseLibrary(outcome, error, fact);
      } else {
        const next = unconfirmed(error, "Rename");
        state.set(latest => ({ ...latest, busy: null, request: { ...request, unconfirmed: true }, unknown: next === null ? latest.unknown : next(latest.unknown) }));
      }
      library.refetch();
    }
  };
  const remove = async () => {
    const value = state.read();
    if (value.busy !== null || value.request !== null) return;
    const fact = current === null ? "couldn’t delete this library." : `couldn’t delete “${current.name}”.`;
    const signal = ctx.sessionSignal();
    setBusy("Delete");
    try {
      await deleteLibrary(libraryId);
      if (signal.aborted) return;
      settleDeletedResourcePanes({
        workspace: workspace(),
        deletedRef: `library:${libraryId}`,
        fallbackHref: "/libraries",
      });
      state.set(value => ({ ...value, busy: null, deleted: true, unknown: null }));
      if (state.read().draft === state.read().baseline && state.read().request === null) onClose();
    } catch (error) {
      if (signal.aborted) return;
      handleUnauthenticatedApiError(error);
      if (!outcomeUnknown(error) && state.read().unknown?.command !== "Delete") {
        setBusy(null);
        refuseLibrary(outcome, error, fact);
      } else {
        const next = unconfirmed(error, "Delete");
        state.set(latest => ({ ...latest, busy: null, unknown: next === null ? latest.unknown : next(latest.unknown) }));
      }
      library.refetch();
    }
  };
  const resend: CommandVerb = unknown?.command === "Delete"
    ? { label: "retry", commandKey: `library-delete:${libraryId}`, busy: busy === "Delete", run: () => void remove() }
    : { label: "retry", commandKey: `library-rename:${libraryId}`, busy: busy === "Rename", run: () => void rename() };

  const recovery = unknown !== null ? <Hold id={`library-settings:${libraryId}:${unknown.command}`} attempt={unknown.attempt}
    {...resendFeedback({ line: { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON }, resend })} /> : null;

  if (current === null) {
    return (
      <Dialog open onClose={onClose} onDismissRequest={requestDismiss} title="Library settings">
        {recovery}
        {draft !== null && draft !== baseline ? <><Input aria-label="unsaved library name" value={draft} readOnly />
          <Fact line={{ fact: "your unsaved name is still here to copy." }} /></> : null}
        {gone ? <Fact line={{ fact: "this library isn’t available.", reason: "it was deleted, or you’re not a member." }} speak />
          : library.status === "failed" ? <Failed error={library.error} noun="library settings" retry={{ run: library.refetch, busy: library.retrying }} />
            : <Ruling />}
      </Dialog>
    );
  }

  const name = (draft ?? current.name).trim();
  const invalid = libraryNameError(name) ?? (state.value.refusedName === name ? NAME_REFUSED : null);
  const renameRequest = state.value.request;
  const renameLabel = renameRequest?.unconfirmed ? "retry"
    : (renameRequest ? renameRequest.expectedName !== baseline : baseline !== current.name) ? "save my name" : "Save";

  return (
    <Dialog open onClose={onClose} onDismissRequest={requestDismiss} title="Library settings">
      <div className={styles.sections}>
        {recovery}
        {deleted ? <Fact line={{ fact: "this library isn’t available.", reason: "your unsaved name is still here to copy." }} speak /> : null}
        <section className={styles.section}>
          <label htmlFor={`library-name-${libraryId}`}>Library name</label>
          <div className={styles.row}>
            <Input
              id={`library-name-${libraryId}`}
              value={draft ?? current.name}
              readOnly={deleted}
              disabled={!current.can_manage || busy !== null}
              aria-invalid={invalid !== null || undefined}
              aria-describedby={invalid ? `library-name-error-${libraryId}` : baseline !== current.name && draft !== baseline ? `library-name-renamed-${libraryId}` : undefined}
              onChange={(event) => state.set(value => ({ ...value, draft: event.target.value }))}
            />
            {current.can_manage && !deleted ? (
              <Button
                emphasis="strong"
                aria-busy={busy === "Rename" || undefined}
                disabled={invalid !== null || renameRequest === null && name === baseline || busy !== null || unknown?.command === "Delete"}
                onClick={() => void rename()}
              >
                {renameLabel}
              </Button>
            ) : null}
          </div>
          {invalid ? <Field id={`library-name-error-${libraryId}`} line={{ fact: invalid }} />
            : baseline !== current.name && draft !== baseline ? <Field id={`library-name-renamed-${libraryId}`} line={{ fact: `it’s now named “${current.name}”.` }} /> : null}
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
                  disabled={busy !== null || renameRequest !== null}
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
              <Button tone="danger" disabled={busy !== null || renameRequest !== null} onClick={() => setConfirming(true)}>
                Delete library…
              </Button>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
