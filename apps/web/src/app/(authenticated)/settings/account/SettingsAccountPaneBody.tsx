"use client";

import { useCallback, useEffect, useState, useTransition, type FormEvent } from "react";
import { apiFetch } from "@/lib/api/client";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import SectionCard from "@/components/ui/SectionCard";
import {
  DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
  DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE,
  EMAIL_CHANGE_SUCCESS_MESSAGE,
} from "@/lib/auth/messages";
import { changeEmailAction } from "./actions";
import styles from "./page.module.css";

export default function SettingsAccountPaneBody({
  initialEmail,
}: {
  initialEmail: string;
}) {
  const [currentEmail, setCurrentEmail] = useState(initialEmail);
  const [emailInput, setEmailInput] = useState(initialEmail);
  const [emailFeedback, setEmailFeedback] = useState<FeedbackContent | null>(
    null
  );
  const [emailPending, startEmailTransition] = useTransition();

  const [currentDisplayName, setCurrentDisplayName] = useState("");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [displayNameFeedback, setDisplayNameFeedback] =
    useState<FeedbackContent | null>(null);
  const [displayNamePending, startDisplayNameTransition] = useTransition();

  useEffect(() => {
    void (async () => {
      try {
        const response = await apiFetch<{ data: { display_name: string | null } }>(
          "/api/me"
        );
        const name = response.data.display_name ?? "";
        setCurrentDisplayName(name);
        setDisplayNameInput(name);
      } catch {
        setDisplayNameFeedback({
          severity: "error",
          title: DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
        });
      }
    })();
  }, []);

  const handleEmailSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setEmailFeedback(null);
      startEmailTransition(async () => {
        const result = await changeEmailAction({ email: emailInput });
        if (!result.ok) {
          setEmailFeedback({ severity: "error", title: result.error });
          return;
        }
        const normalized = emailInput.trim().toLowerCase();
        setCurrentEmail(normalized);
        setEmailInput(normalized);
        setEmailFeedback({
          severity: "success",
          title: EMAIL_CHANGE_SUCCESS_MESSAGE,
        });
      });
    },
    [emailInput]
  );

  const handleDisplayNameSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setDisplayNameFeedback(null);
      startDisplayNameTransition(async () => {
        try {
          const response = await apiFetch<{
            data: { display_name: string | null };
          }>("/api/me", {
            method: "PATCH",
            body: JSON.stringify({ display_name: displayNameInput }),
          });
          const name = response.data.display_name ?? "";
          setCurrentDisplayName(name);
          setDisplayNameInput(name);
          setDisplayNameFeedback({
            severity: "success",
            title: DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE,
          });
        } catch {
          setDisplayNameFeedback({
            severity: "error",
            title: DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
          });
        }
      });
    },
    [displayNameInput]
  );

  return (
    <div className={styles.content}>
      <SectionCard title="Email">
        <form className={styles.form} onSubmit={handleEmailSubmit}>
          {emailFeedback ? <FeedbackNotice feedback={emailFeedback} /> : null}
          <p className={styles.current}>Current: {currentEmail}</p>
          <label className={styles.field}>
            <span className={styles.label}>New email</span>
            <Input
              type="email"
              autoComplete="email"
              required
              value={emailInput}
              onChange={(event) => setEmailInput(event.target.value)}
              disabled={emailPending}
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            loading={emailPending}
            disabled={!emailInput.trim() || emailInput.trim().toLowerCase() === currentEmail}
          >
            Update email
          </Button>
        </form>
      </SectionCard>

      <SectionCard title="Display name">
        <form className={styles.form} onSubmit={handleDisplayNameSubmit}>
          {displayNameFeedback ? (
            <FeedbackNotice feedback={displayNameFeedback} />
          ) : null}
          <p className={styles.current}>Current: {currentDisplayName || "(not set)"}</p>
          <label className={styles.field}>
            <span className={styles.label}>New display name</span>
            <Input
              type="text"
              autoComplete="name"
              required
              minLength={1}
              maxLength={80}
              value={displayNameInput}
              onChange={(event) => setDisplayNameInput(event.target.value)}
              disabled={displayNamePending}
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            loading={displayNamePending}
            disabled={
              !displayNameInput.trim() ||
              displayNameInput.trim() === currentDisplayName
            }
          >
            Update display name
          </Button>
        </form>
      </SectionCard>
    </div>
  );
}
