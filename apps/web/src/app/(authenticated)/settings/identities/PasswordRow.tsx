"use client";

import { useCallback, useState, useTransition } from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Dialog from "@/components/ui/Dialog";
import Input from "@/components/ui/Input";
import ResourceList from "@/components/ui/ResourceList";
import ResourceRow from "@/components/ui/ResourceRow";
import {
  findEmailIdentity,
  mayRemovePassword,
  type LinkedIdentity,
} from "@/lib/auth/identities";
import {
  changePasswordAction,
  removePasswordAction,
  setPasswordAction,
} from "@/lib/auth/password-actions";
import styles from "./page.module.css";

export function PasswordRow({
  identities,
  onChanged,
}: {
  identities: readonly LinkedIdentity[];
  onChanged: () => Promise<void>;
}) {
  const emailIdentity = findEmailIdentity(identities);
  const removable = mayRemovePassword(identities);

  const [mode, setMode] = useState<"set" | "change" | null>(null);
  const [password, setPassword] = useState("");
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const closeDialog = useCallback(() => {
    setMode(null);
    setPassword("");
    setDialogError(null);
  }, []);

  const submit = useCallback(() => {
    if (password.length < 12) {
      return;
    }
    const action = mode === "set" ? setPasswordAction : changePasswordAction;
    startTransition(async () => {
      const result = await action({ password });
      if (!result.ok) {
        setDialogError(result.error);
        setPassword("");
        return;
      }
      await onChanged();
      closeDialog();
    });
  }, [mode, password, onChanged, closeDialog]);

  const remove = useCallback(() => {
    if (!window.confirm("Remove password?")) {
      return;
    }
    setRowError(null);
    startTransition(async () => {
      const result = await removePasswordAction();
      if (!result.ok) {
        setRowError(result.error);
        return;
      }
      await onChanged();
    });
  }, [onChanged]);

  return (
    <>
      <ResourceList>
        {emailIdentity ? (
          <ResourceRow
            primary={{ kind: "static" }}
            title="Password"
            description={`Password is set on ${emailIdentity.email ?? "your account"}`}
            actions={
              <div className={styles.rowActions}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setPassword("");
                    setDialogError(null);
                    setMode("change");
                  }}
                  disabled={pending}
                >
                  Change password
                </Button>
                {removable ? (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={remove}
                    disabled={pending}
                  >
                    {pending ? "Removing..." : "Remove password"}
                  </Button>
                ) : (
                  <>
                    <Button variant="danger" size="sm" disabled>
                      Remove password
                    </Button>
                    <span className={styles.unlinkHint}>
                      Add a linked provider first
                    </span>
                  </>
                )}
              </div>
            }
          />
        ) : (
          <ResourceRow
            primary={{ kind: "static" }}
            title="Password"
            description="Sign in with email and password"
            actions={
              <Button
                variant="pill"
                onClick={() => {
                  setPassword("");
                  setDialogError(null);
                  setMode("set");
                }}
                disabled={pending}
              >
                Set password
              </Button>
            }
          />
        )}
      </ResourceList>

      {rowError ? <FeedbackNotice severity="error" title={rowError} /> : null}

      {mode === "set" ? (
        <Dialog open onClose={closeDialog} title="Set password">
          <form
            className={styles.content}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              aria-label="New password"
            />
            {dialogError ? (
              <FeedbackNotice severity="error" title={dialogError} />
            ) : null}
            <div className={styles.rowActions}>
              <Button
                variant="ghost"
                type="button"
                onClick={closeDialog}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={pending || password.length < 12}
              >
                {pending ? "Setting..." : "Set password"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}

      {mode === "change" ? (
        <Dialog open onClose={closeDialog} title="Change password">
          <form
            className={styles.content}
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Input
              type="password"
              autoComplete="new-password"
              minLength={12}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              aria-label="New password"
            />
            {dialogError ? (
              <FeedbackNotice severity="error" title={dialogError} />
            ) : null}
            <div className={styles.rowActions}>
              <Button
                variant="ghost"
                type="button"
                onClick={closeDialog}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={pending || password.length < 12}
              >
                {pending ? "Changing..." : "Change password"}
              </Button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  );
}
