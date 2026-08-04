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
import {
  apiFetch,
  isApiError,
  isSameSystemApiDefect,
} from "@/lib/api/client";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import {
  DISPLAY_NAME_CHANGE_FAILURE_MESSAGE,
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
import {
  ClipboardWriteUnavailableError,
  copyText,
} from "@/lib/ui/copyText";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import {
  decodeAuthenticatedAccountProfile,
  isAuthenticatedAccountContractDefect,
} from "@/lib/account/contract";

interface AccountResponse {
  data: unknown;
}

type AccountOperation = "Load" | "DisplayName" | "CalendarTimeZone";

/** Exhaustive copy projection for the finite `/api/me` browser error channel. */
function accountErrorMessage(
  error: unknown,
  operation: AccountOperation,
): FeedbackContent {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;

  const requestId = error.requestId;
  const title =
    operation === "Load"
      ? "Account settings couldn’t be loaded"
      : operation === "DisplayName"
        ? DISPLAY_NAME_CHANGE_FAILURE_MESSAGE
        : "Calendar time zone couldn’t be updated";
  switch (error.code) {
    case "E_NETWORK":
      return {
        tone: "Danger",
        title,
        message: "Check your connection and retry.",
        requestId,
      };
    case "E_UPSTREAM_TIMEOUT":
      return {
        tone: "Danger",
        title,
        message: "The server took too long to respond. Retry the change.",
        requestId,
      };
    case "E_RATE_LIMITED":
      return {
        tone: "Danger",
        title,
        message: "Wait a moment, then retry.",
        requestId,
      };
    case "E_INVALID_REQUEST":
      if (operation === "Load") throw error;
      return {
        tone: "Danger",
        title,
        message:
          operation === "DisplayName"
            ? "Enter a display name between 1 and 80 characters."
            : "Enter an IANA time zone such as America/Los_Angeles.",
        requestId,
      };
    default:
      throw error;
  }
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
  const accountLoadFailure =
    accountResource.status === "error"
      ? {
          content: accountErrorMessage(accountResource.error, "Load"),
          retry: accountResource.retry,
        }
      : null;
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
      } catch (error) {
        if (error instanceof ClipboardWriteUnavailableError) {
          setIngestAddressCopyFailed(true);
          return;
        }
        setContractDefect({ error });
      }
    },
    []
  );

  const [currentEmail, setCurrentEmail] = useState("");
  const [emailInput, setEmailInput] = useState("");
  const emailDirtyRef = useRef(false);
  const [emailFeedback, setEmailFeedback] = useState<{
    content: FeedbackContent;
    announcement: "Polite" | "Assertive";
  } | null>(null);
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
  }, [accountProfile, accountResource.status]);

  const handleEmailSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setEmailFeedback(null);
      startEmailTransition(async () => {
        const result = await changeEmailAction({ email: emailInput });
        if (!result.ok) {
          setEmailFeedback({
            content: { tone: "Danger", title: result.error },
            announcement: "Assertive",
          });
          return;
        }
        const normalized = emailInput.trim().toLowerCase();
        setCurrentEmail(normalized);
        setEmailInput(normalized);
        emailDirtyRef.current = false;
        setEmailFeedback({
          content: {
            tone: "Info",
            title: EMAIL_CHANGE_CONFIRMATION_SENT_MESSAGE,
          },
          announcement: "Polite",
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
          setDisplayNameFeedback(null);
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          if (isAuthenticatedAccountContractDefect(error)) {
            setContractDefect({ error });
            return;
          }
          try {
            setDisplayNameFeedback(accountErrorMessage(error, "DisplayName"));
          } catch (defect) {
            setContractDefect({ error: defect });
          }
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
          setCalendarTimeZoneFeedback(null);
        } catch (error) {
          if (handleUnauthenticatedApiError(error)) return;
          if (isAuthenticatedAccountContractDefect(error)) {
            setContractDefect({ error });
            return;
          }
          try {
            setCalendarTimeZoneFeedback(
              accountErrorMessage(error, "CalendarTimeZone"),
            );
          } catch (defect) {
            setContractDefect({ error: defect });
          }
        }
      });
    },
    [calendarTimeZoneInput, setCalendarTimeZone],
  );

  if (contractDefect) throw contractDefect.error;

  return (
    <PaneSurface>
      <PaneSection title="Email">
        <form className={styles.form} onSubmit={handleEmailSubmit}>
          {accountLoadFailure ? (
            <FeedbackNotice
              content={accountLoadFailure.content}
              announcement="Assertive"
              actions={[
                {
                  label: "Retry",
                  onClick: accountLoadFailure.retry,
                },
              ]}
            />
          ) : null}
          {emailFeedback ? (
            <FeedbackNotice
              content={emailFeedback.content}
              announcement={emailFeedback.announcement}
            />
          ) : null}
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
            <FeedbackNotice
              content={displayNameFeedback}
              announcement="Assertive"
            />
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
            <FeedbackNotice
              content={calendarTimeZoneFeedback}
              announcement="Assertive"
            />
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
