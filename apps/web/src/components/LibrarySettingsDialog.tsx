"use client";

// Library settings, opened by id: rename (sent with the name it replaces) and
// delete (owner only, confirmed). Deleting a library never deletes media: items
// filed only there move to the owner's All. Membership lives in the Members tab.

import { useEffect, useRef, useState } from "react";
import { FeedbackNotice, FeedbackState, FieldFeedback, type FeedbackContent } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { useChangeStamp } from "@/lib/api/changes";
import { usePaneFreeServerValue, useThrowLater } from "@/lib/api/serverState";
import { deleteLibrary, getLibrary, renameLibrary } from "@/lib/libraries/api";
import { libraryErrorFeedback, throwDefect } from "@/lib/libraries/errors";
import { RESERVED_NAME, isReservedName } from "@/lib/libraries/views";
import { useLatestWorkspace } from "@/lib/workspace/store";
import styles from "./LibrarySettingsDialog.module.css";

export default function LibrarySettingsDialog({
  libraryId,
  onClose,
}: {
  readonly libraryId: string;
  readonly onClose: () => void;
}) {
  const fail = useThrowLater();
  const contentRef = useRef<HTMLDivElement>(null);
  const workspace = useLatestWorkspace();
  const library = usePaneFreeServerValue({
    key: libraryId,
    stale: useChangeStamp("Libraries"),
    load: (signal) => getLibrary(libraryId, signal),
  });
  const current = library.status === "ready" ? library.data : null;
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<"Rename" | "Delete" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  // The field follows the stored name until the viewer edits it.
  useEffect(() => setDraft(null), [current?.name]);

  if (current === null) {
    const failure =
      library.status === "failed"
        ? libraryErrorFeedback(library.error, "Library settings couldn’t be loaded", throwDefect)
        : null;
    return (
      <Dialog open onClose={onClose} title="Library settings">
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
  const reserved = isReservedName(name);
  const rename = async () => {
    setBusy("Rename");
    setFeedback(null);
    try {
      await renameLibrary(libraryId, name, current.name);
    } catch (error) {
      setFeedback(libraryErrorFeedback(error, "Library name wasn’t saved", fail));
      library.refetch();
    } finally {
      setBusy(null);
    }
  };
  const remove = async () => {
    setBusy("Delete");
    setFeedback(null);
    try {
      await deleteLibrary(libraryId);
      settleDeletedResourcePanes({
        workspace: workspace(),
        deletedRef: `library:${libraryId}`,
        fallbackHref: "/libraries",
      });
      onClose();
    } catch (error) {
      setFeedback(libraryErrorFeedback(error, "Library couldn’t be deleted", fail));
      setBusy(null);
    }
  };

  return (
    <Dialog open onClose={onClose} title="Library settings">
      <div className={styles.sections} ref={contentRef} tabIndex={-1}>
        {feedback ? <FeedbackNotice content={feedback} announcement="Assertive" /> : null}
        <section className={styles.section}>
          <label htmlFor={`library-name-${libraryId}`}>Library name</label>
          <div className={styles.row}>
            <Input
              id={`library-name-${libraryId}`}
              value={draft ?? current.name}
              disabled={!current.can_manage || busy !== null}
              aria-invalid={reserved || undefined}
              aria-describedby={reserved ? `library-name-error-${libraryId}` : undefined}
              onChange={(event) => setDraft(event.target.value)}
            />
            {current.can_manage ? (
              <Button
                variant="secondary"
                size="sm"
                loading={busy === "Rename"}
                disabled={!name || name === current.name || reserved || busy !== null}
                onClick={() => void rename()}
              >
                Save
              </Button>
            ) : null}
          </div>
          {reserved ? (
            <FieldFeedback id={`library-name-error-${libraryId}`} content={{ tone: "Warning", title: RESERVED_NAME }} />
          ) : null}
        </section>
        {current.can_delete ? (
          <section className={styles.danger}>
            <h3>Delete library</h3>
            <p>
              Deletes “{current.name}” for every member. Items filed only here move to
              your All; nothing else is deleted.
            </p>
            {confirming ? (
              <div className={styles.row}>
                <Button
                  variant="danger"
                  size="sm"
                  loading={busy === "Delete"}
                  disabled={busy !== null}
                  onClick={() => void remove()}
                >
                  Delete library
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => setConfirming(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
                Delete library…
              </Button>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
