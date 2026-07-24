"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import styles from "./LibrarySettingsDialog.module.css";

export interface LibraryForSettings {
  id: string;
  name: string;
  canRename: boolean;
  canDelete: boolean;
}

interface LibrarySettingsDialogProps {
  open: boolean;
  onClose: () => void;
  library: LibraryForSettings;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

/**
 * Library settings deliberately excludes membership, invitations, roles, and
 * ownership. Those access concerns live only in the universal Share surface.
 */
export default function LibrarySettingsDialog({
  open,
  onClose,
  library,
  onRename,
  onDelete,
}: LibrarySettingsDialogProps) {
  const [draftName, setDraftName] = useState(library.name);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (open) {
      setDraftName(library.name);
      setConfirmDelete(false);
    }
  }, [library.name, open]);

  const trimmedName = draftName.trim();
  const nameChanged = trimmedName.length > 0 && trimmedName !== library.name;

  return (
    <Dialog open={open} onClose={onClose} title="Library settings">
      <div className={styles.sections}>
        <section className={styles.section}>
          <label htmlFor={`library-name-${library.id}`}>Library name</label>
          <div className={styles.row}>
            <Input
              id={`library-name-${library.id}`}
              value={draftName}
              disabled={!library.canRename || saving}
              onChange={(event) => setDraftName(event.target.value)}
            />
            {library.canRename ? (
              <Button
                variant="secondary"
                size="sm"
                loading={saving}
                disabled={!nameChanged}
                onClick={async () => {
                  setSaving(true);
                  try {
                    await onRename(trimmedName);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                Save
              </Button>
            ) : null}
          </div>
        </section>

        {library.canDelete ? (
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
                  loading={deleting}
                  onClick={async () => {
                    setDeleting(true);
                    try {
                      await onDelete();
                    } finally {
                      setDeleting(false);
                    }
                  }}
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
