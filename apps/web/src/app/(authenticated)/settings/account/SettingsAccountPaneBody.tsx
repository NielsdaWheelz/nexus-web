"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type FormEvent,
} from "react";
import { apiFetch } from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import {
  DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
  DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE,
  EMAIL_CHANGE_CONFIRMATION_SENT_MESSAGE,
} from "@/lib/auth/messages";
import {
  settingsAccountResource,
  type NoResourceParams,
} from "@/lib/api/resource";
import { useResource } from "@/lib/api/useResource";
import { usePaneReturnReady } from "@/lib/panes/paneRuntime";
import { changeEmailAction } from "./actions";
import styles from "./page.module.css";
import { copyText } from "@/lib/ui/copyText";

interface AccountResponse {
  data: {
    email?: string;
    display_name: string | null;
    email_ingest_address?: string | null;
  };
}

export default function SettingsAccountPaneBody() {
  const accountResource = useResource<AccountResponse, NoResourceParams>({
    descriptor: settingsAccountResource,
    params: {},
  });

  const [ingestAddressCopied, setIngestAddressCopied] = useState(false);
  const [ingestAddressCopyFailed, setIngestAddressCopyFailed] = useState(false);

  const handleCopyIngestAddress = useCallback(
    async (address: string) => {
      setIngestAddressCopyFailed(false);
      try {
        await copyText(address);
        setIngestAddressCopied(true);
        setTimeout(() => setIngestAddressCopied(false), 2000);
      } catch {
        setIngestAddressCopyFailed(true);
      }
    },
    []
  );

  const [currentEmail, setCurrentEmail] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const emailDirtyRef = useRef(false);
  const [emailFeedback, setEmailFeedback] = useState<FeedbackContent | null>(
    null
  );
  const [emailPending, startEmailTransition] = useTransition();

  const [currentDisplayName, setCurrentDisplayName] = useState("");
  const [displayNameInput, setDisplayNameInput] = useState("");
  const displayNameDirtyRef = useRef(false);
  const [displayNameFeedback, setDisplayNameFeedback] =
    useState<FeedbackContent | null>(null);
  const [displayNamePending, startDisplayNameTransition] = useTransition();
  const [mounted, setMounted] = useState(false);
  const accountReady = mounted && accountResource.status === "ready";
  usePaneReturnReady(
    mounted &&
      (accountResource.status === "ready" ||
        accountResource.status === "error"),
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (accountResource.status === "ready") {
      const email =
        typeof accountResource.data.data.email === "string"
          ? accountResource.data.data.email
          : "";
      if (email) {
        setCurrentEmail(email);
        if (!emailDirtyRef.current) {
          setEmailInput(email);
        }
      }
      const name = accountResource.data.data.display_name ?? "";
      setCurrentDisplayName(name);
      if (!displayNameDirtyRef.current) {
        setDisplayNameInput(name);
      }
      return;
    }

    if (accountResource.status === "error") {
      setDisplayNameFeedback({
        severity: "error",
        title: DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
      });
    }
  }, [accountResource]);

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
        emailDirtyRef.current = false;
        setEmailFeedback({
          severity: "success",
          title: EMAIL_CHANGE_CONFIRMATION_SENT_MESSAGE,
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
          displayNameDirtyRef.current = false;
          setDisplayNameFeedback({
            severity: "success",
            title: DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE,
          });
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
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
    <PaneSurface opener={<SectionOpener heading="Account" />}>
      <PaneSection title="Email">
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
              onChange={(event) => {
                emailDirtyRef.current = true;
                setEmailInput(event.target.value);
              }}
              disabled={!accountReady || emailPending}
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            loading={emailPending}
            disabled={
              !accountReady ||
              !emailInput.trim() ||
              emailInput.trim().toLowerCase() === currentEmail
            }
          >
            Update email
          </Button>
        </form>
      </PaneSection>

      <PaneSection title="Display name">
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
              onChange={(event) => {
                displayNameDirtyRef.current = true;
                setDisplayNameInput(event.target.value);
              }}
              disabled={!accountReady || displayNamePending}
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            loading={displayNamePending}
            disabled={
              !accountReady ||
              !displayNameInput.trim() ||
              displayNameInput.trim() === currentDisplayName
            }
          >
            Update display name
          </Button>
        </form>
      </PaneSection>

      <PaneSection title="Post Room">
        {accountResource.status !== "ready" ? null : accountResource.data.data
            .email_ingest_address ? (
          <>
            <p className={styles.current}>
              <code>{accountResource.data.data.email_ingest_address}</code>
            </p>
            <Button
              variant="ghost"
              onClick={() =>
                handleCopyIngestAddress(
                  accountResource.data.data.email_ingest_address!
                )
              }
            >
              {ingestAddressCopied
                ? "Copied"
                : ingestAddressCopyFailed
                  ? "Copy failed"
                  : "Copy address"}
            </Button>
            <p className={styles.current}>
              Forward newsletters here. Rotating the address is an env change +
              redeploy.
            </p>
          </>
        ) : (
          <p className={styles.current}>The Post Room is not configured.</p>
        )}
      </PaneSection>
    </PaneSurface>
  );
}
