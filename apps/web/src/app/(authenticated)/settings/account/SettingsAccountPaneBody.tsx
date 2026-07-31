"use client";

import {
  useCallback,
  useEffect,
  useMemo,
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
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import {
  decodeAuthenticatedAccountProfile,
  isAuthenticatedAccountContractDefect,
} from "@/lib/account/contract";

interface AccountResponse {
  data: unknown;
}

export default function SettingsAccountPaneBody() {
  const { setCalendarTimeZone } = useAuthenticatedAccount();
  const accountResource = useResource<AccountResponse, NoResourceParams>({
    descriptor: settingsAccountResource,
    params: {},
  });
  const accountProfile = useMemo(
    () =>
      accountResource.status === "ready"
        ? decodeAuthenticatedAccountProfile(accountResource.data.data)
        : null,
    [accountResource],
  );
  const [contractDefect, setContractDefect] = useState<{
    error: unknown;
  } | null>(null);

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
  const [currentCalendarTimeZone, setCurrentCalendarTimeZone] = useState("");
  const [calendarTimeZoneInput, setCalendarTimeZoneInput] = useState("");
  const calendarTimeZoneDirtyRef = useRef(false);
  const [calendarTimeZoneFeedback, setCalendarTimeZoneFeedback] =
    useState<FeedbackContent | null>(null);
  const [calendarTimeZonePending, startCalendarTimeZoneTransition] =
    useTransition();
  const [mounted, setMounted] = useState(false);
  const accountReady = mounted && accountProfile !== null;
  usePaneReturnReady(
    mounted &&
      (accountResource.status === "ready" ||
        accountResource.status === "error"),
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (accountProfile !== null) {
      const email = accountProfile.email ?? "";
      if (email) {
        setCurrentEmail(email);
        if (!emailDirtyRef.current) {
          setEmailInput(email);
        }
      }
      const name = accountProfile.displayName ?? "";
      setCurrentDisplayName(name);
      if (!displayNameDirtyRef.current) {
        setDisplayNameInput(name);
      }
      const calendarTimeZone = accountProfile.calendarTimeZone;
      setCurrentCalendarTimeZone(calendarTimeZone);
      if (!calendarTimeZoneDirtyRef.current) {
        setCalendarTimeZoneInput(calendarTimeZone);
      }
      return;
    }

    if (accountResource.status === "error") {
      setDisplayNameFeedback({
        severity: "error",
        title: DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
      });
      setCalendarTimeZoneFeedback({
        severity: "error",
        title: "Calendar time zone could not be loaded.",
      });
    }
  }, [accountProfile, accountResource.status]);

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
          const response = await apiFetch<{ data: unknown }>("/api/me", {
            method: "PATCH",
            body: JSON.stringify({ display_name: displayNameInput }),
          });
          const profile = decodeAuthenticatedAccountProfile(response.data);
          const name = profile.displayName ?? "";
          setCurrentDisplayName(name);
          setDisplayNameInput(name);
          displayNameDirtyRef.current = false;
          setDisplayNameFeedback({
            severity: "success",
            title: DISPLAY_NAME_CHANGE_SUCCESS_MESSAGE,
          });
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          if (isAuthenticatedAccountContractDefect(error)) {
            setContractDefect({ error });
            return;
          }
          setDisplayNameFeedback({
            severity: "error",
            title: DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
          });
        }
      });
    },
    [displayNameInput]
  );

  const handleCalendarTimeZoneSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCalendarTimeZoneFeedback(null);
      startCalendarTimeZoneTransition(async () => {
        try {
          const requestedCalendarTimeZone = calendarTimeZoneInput.trim();
          const response = await apiFetch<{ data: unknown }>("/api/me", {
            method: "PATCH",
            body: JSON.stringify({
              calendar_time_zone: requestedCalendarTimeZone,
            }),
          });
          const profile = decodeAuthenticatedAccountProfile(response.data);
          const calendarTimeZone = profile.calendarTimeZone;
          setCurrentCalendarTimeZone(calendarTimeZone);
          setCalendarTimeZoneInput(calendarTimeZone);
          calendarTimeZoneDirtyRef.current = false;
          setCalendarTimeZone(calendarTimeZone);
          setCalendarTimeZoneFeedback({
            severity: "success",
            title: "Calendar time zone updated.",
          });
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          if (isAuthenticatedAccountContractDefect(error)) {
            setContractDefect({ error });
            return;
          }
          setCalendarTimeZoneFeedback({
            severity: "error",
            title: "Calendar time zone could not be updated.",
          });
        }
      });
    },
    [calendarTimeZoneInput, setCalendarTimeZone],
  );

  if (contractDefect) throw contractDefect.error;

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

      <PaneSection title="Calendar time zone">
        <form className={styles.form} onSubmit={handleCalendarTimeZoneSubmit}>
          {calendarTimeZoneFeedback ? (
            <FeedbackNotice feedback={calendarTimeZoneFeedback} />
          ) : null}
          <p className={styles.current}>
            Current: {currentCalendarTimeZone}
          </p>
          <label className={styles.field}>
            <span className={styles.label}>Calendar time zone</span>
            <Input
              type="text"
              autoComplete="off"
              required
              value={calendarTimeZoneInput}
              onChange={(event) => {
                calendarTimeZoneDirtyRef.current = true;
                setCalendarTimeZoneInput(event.target.value);
              }}
              disabled={!accountReady || calendarTimeZonePending}
            />
          </label>
          <p className={styles.current}>
            Use an IANA time zone, for example America/Los_Angeles.
          </p>
          <Button
            type="submit"
            variant="primary"
            loading={calendarTimeZonePending}
            disabled={
              !accountReady ||
              !calendarTimeZoneInput.trim() ||
              calendarTimeZoneInput.trim() === currentCalendarTimeZone
            }
          >
            Update calendar time zone
          </Button>
        </form>
      </PaneSection>

      <PaneSection title="Post Room">
        {accountProfile === null ? null : accountProfile.emailIngestAddress ? (
          <>
            <p className={styles.current}>
              <code>{accountProfile.emailIngestAddress}</code>
            </p>
            <Button
              variant="ghost"
              onClick={() =>
                handleCopyIngestAddress(accountProfile.emailIngestAddress!)
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
