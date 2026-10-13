"use client";

import { useEffect, useState } from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import { settleDeletedResourcePanes } from "@/lib/actions/settleDeletedResource";
import { useChangeStamp } from "@/lib/api/changes";
import {
  modeledApiError,
  usePaneFreeServerValue,
  useThrowLater,
} from "@/lib/api/serverState";
import {
  deleteMemberLibrary,
  getMemberLibrary,
  renameMemberLibrary,
} from "@/lib/libraries/client";
import type { LibraryOut } from "@/lib/libraries/contract";
import {
  isReservedLibraryName,
  RESERVED_LIBRARY_NAME_MESSAGE,
} from "@/lib/libraries/presentation";
import { useLatestWorkspace } from "@/lib/workspace/store";
import styles from "./LibrarySettingsDialog.module.css";

/**
 * Rename or delete one library, loaded by id. Membership, invitations, roles
 * and ownership live only in the universal Share surface.
 */
export default function LibrarySettingsDialog({
  libraryId,
  onClose,
}: {
  readonly libraryId: string;
  readonly onClose: () => void;
}) {
  const feedback = useFeedback();
  const library = usePaneFreeServerValue({
    key: libraryId,
    stale: useChangeStamp("Libraries"),
    load: (signal) => getMemberLibrary(libraryId, signal),
  });
  const failed = library.status === "failed" ? library.error : null;
  useEffect(() => {
    if (failed === null) return;
    feedback.publish({
      kind: "Hud",
      content: {
        tone: "Danger",
        title: "Library settings couldn’t be loaded",
        requestId: failed.requestId,
      },
    });
    onClose();
  }, [failed, feedback, onClose]);
  return library.status === "ready" ? (
    <Settings library={library.data} onClose={onClose} />
  ) : null;
}

function Settings({
  library,
  onClose,
}: {
  readonly library: LibraryOut;
  readonly onClose: () => void;
}) {
  const feedback = useFeedback();
  const fail = useThrowLater();
  const workspace = useLatestWorkspace();
  const [draftName, setDraftName] = useState(library.name);
  const [pending, setPending] = useState<"Rename" | "Delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const trimmedName = draftName.trim();
  const nameReserved = isReservedLibraryName(trimmedName);
  const nameChanged = trimmedName.length > 0 && trimmedName !== library.name;
  const nameId = `library-name-${library.id}`;

  const run = async (op: "Rename" | "Delete", failure: string) => {
    setPending(op);
    try {
      if (op === "Rename") await renameMemberLibrary(library.id, trimmedName);
      else {
        await deleteMemberLibrary(library.id);
        settleDeletedResourcePanes({
          workspace: workspace(),
          deletedRef: `library:${library.id}`,
          fallbackHref: "/libraries",
        });
        onClose();
      }
    } catch (caught) {
      const error = modeledApiError(caught, fail);
      if (error !== null)
        feedback.publish({
          kind: "Hud",
          content: { tone: "Danger", title: failure, requestId: error.requestId },
        });
    } finally {
      setPending(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Library settings"
      onDismissRequest={() => (pending ? "blocked" : "accepted")}
    >
      <div className={styles.sections}>
        <section className={styles.section}>
          <label htmlFor={nameId}>Library name</label>
          <div className={styles.row}>
            <Input
              id={nameId}
              value={draftName}
              disabled={!library.can_rename || pending !== null}
              aria-invalid={nameReserved || undefined}
              aria-describedby={nameReserved ? `${nameId}-error` : undefined}
              onChange={(event) => setDraftName(event.target.value)}
            />
            {library.can_rename ? (
              <Button
                variant="secondary"
                size="sm"
                loading={pending === "Rename"}
                disabled={!nameChanged || nameReserved || pending !== null}
                onClick={() => void run("Rename", "Library name wasn’t saved")}
              >
                Save
              </Button>
            ) : null}
          </div>
          {nameReserved ? (
            <p id={`${nameId}-error`} className={styles.error} role="alert">
              {RESERVED_LIBRARY_NAME_MESSAGE}
            </p>
          ) : null}
        </section>
        {library.can_delete ? (
          <section className={styles.danger}>
            <h3>Delete library</h3>
            <p>
              Deletes this library and its filing structure. It does not delete
              the underlying media.
            </p>
            {confirmDelete ? (
              <div className={styles.row}>
                <Button
                  variant="danger"
                  size="sm"
                  loading={pending === "Delete"}
                  disabled={pending !== null}
                  onClick={() =>
                    void run("Delete", "Library couldn’t be deleted")
                  }
                >
                  Delete library
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmDelete(true)}
              >
                Delete library…
              </Button>
            )}
          </section>
        ) : null}
      </div>
    </Dialog>
  );
}
