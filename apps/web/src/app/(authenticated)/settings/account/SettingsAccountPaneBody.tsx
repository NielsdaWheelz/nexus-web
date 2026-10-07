"use client";

import Link from "next/link";
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
  type ApiPath,
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
import { usePaneReturnReady, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { changeEmailAction } from "./actions";
import styles from "./page.module.css";
import {
  ClipboardWriteUnavailableError,
  copyText,
} from "@/lib/ui/copyText";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { decodeAuthenticatedAccountProfile } from "@/lib/account/contract";
import { isAbortError } from "@/lib/errors";

interface AccountResponse {
  data: unknown;
}

interface GenerationEffect {
  position_id: string;
  generation_id: string;
  canonical_id: string;
  replay_status: "Prepared" | "Uncertain" | "Completed";
  created_at: string;
  created_refs: Array<Record<string, unknown>> | null;
  result: { type: "Success" | "Failure" } | null;
  reverted_at: string | null;
  undo_allowed: boolean;
  undo_url: string | null;
}

interface GenerationEffectsPage {
  items: GenerationEffect[];
  next_cursor: string | null;
}

function effectErrorMessage(error: unknown): string {
  if (!isApiError(error) || isSameSystemApiDefect(error)) throw error;
  if (error.code === "E_NETWORK") return "Check your connection and try again.";
  if (error.status === 409) return "This write changed. Refresh the history before trying again.";
  return "The request failed. Refresh the history to check its current state.";
}

function effectStatus(effect: GenerationEffect, undone: boolean): string {
  if (effect.reverted_at || undone) return "Undone";
  if (effect.replay_status === "Uncertain") return "Outcome uncertain; inspect before retrying";
  if (effect.replay_status === "Prepared") return "In progress";
  if (effect.result?.type !== "Success") return "No write completed";
  return effect.created_refs?.length ? "Assistant-created" : "Completed; no new item created";
}

function GenerationEffects({ generationId, positionId }: { generationId: string | null; positionId: string | null }) {
  const [page, setPage] = useState<GenerationEffectsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [undone, setUndone] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);
  const selectedRef = useRef<HTMLLIElement | null>(null);
  const revealedRef = useRef(false);
  const path = generationId
    ? `/api/generation-effects?generation_id=${encodeURIComponent(generationId)}` as ApiPath
    : "/api/generation-effects";

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const next = await apiFetch<GenerationEffectsPage>(path, {
        cache: "no-store",
        signal,
      });
      if (!signal?.aborted) {
        setPage(next);
        setUndone(new Set());
      }
    } catch (caught) {
      if (signal?.aborted || isAbortError(caught)) return;
      if (handleUnauthenticatedApiError(caught)) return;
      try {
        setError(effectErrorMessage(caught));
      } catch (unexpected) {
        setDefect({ error: unexpected });
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (revealedRef.current || !selectedRef.current) return;
    selectedRef.current.scrollIntoView({ block: "nearest" });
    selectedRef.current.focus({ preventScroll: true });
    revealedRef.current = true;
  }, [page]);

  const loadMore = useCallback(async () => {
    if (!page?.next_cursor || loading || loadingMore || busyId !== null) return;
    setLoadingMore(true);
    setError(null);
    try {
      const continuation = `${path}${generationId ? "&" : "?"}before=${encodeURIComponent(page.next_cursor)}` as ApiPath;
      const next = await apiFetch<GenerationEffectsPage>(continuation, { cache: "no-store" });
      setPage({ items: [...page.items, ...next.items], next_cursor: next.next_cursor });
    } catch (caught) {
      if (handleUnauthenticatedApiError(caught)) return;
      try {
        setError(effectErrorMessage(caught));
      } catch (unexpected) {
        setDefect({ error: unexpected });
      }
    } finally {
      setLoadingMore(false);
    }
  }, [page, loading, loadingMore, busyId, path, generationId]);

  useEffect(() => {
    if (!positionId || error || page?.items.some((effect) => effect.position_id === positionId)) return;
    if (page?.next_cursor) void loadMore();
  }, [positionId, error, page, loadMore]);

  const undo = async (effect: GenerationEffect) => {
    if (!effect.undo_allowed || !effect.undo_url || undone.has(effect.position_id) || busyId || loading || loadingMore) return;
    setBusyId(effect.position_id);
    setError(null);
    try {
      if (effect.undo_url !== `/generation-effects/${effect.position_id}/undo`) {
        throw new Error("Undo URL does not match the selected write");
      }
      const path = `/api${effect.undo_url}` as ApiPath;
      const receipt = await apiFetch<{ position_id: string; reverted: boolean; changed: boolean }>(
        path,
        { method: "POST" },
      );
      if (receipt.position_id !== effect.position_id || !receipt.reverted) {
        throw new Error("Undo returned a mismatched receipt");
      }
      setUndone((current) => new Set(current).add(effect.position_id));
    } catch (caught) {
      if (handleUnauthenticatedApiError(caught)) return;
      try {
        setError(effectErrorMessage(caught));
      } catch (unexpected) {
        setDefect({ error: unexpected });
      }
    } finally {
      setBusyId(null);
    }
  };

  if (defect) throw defect.error;

  return (
    <PaneSection
      id="background-writes"
      title="Background writes"
      description={generationId ? "Writes from the generation that created this link." : "Recent writes by background generations. Shell activity is outside this history."}
      actions={<Button variant="ghost" size="sm" onClick={() => void refresh()} disabled={loading || loadingMore || busyId !== null}>Refresh</Button>}
    >
      {error ? <p className={styles.effectsError} role="alert">{error}</p> : null}
      {loading && page === null ? <p className={styles.current}>Loading writes…</p> : null}
      {!loading && page?.items.length === 0 ? <p className={styles.current}>{generationId ? "Creation history is no longer available." : "No background writes yet."}</p> : null}
      {positionId && page && !page.items.some((effect) => effect.position_id === positionId) ? <p className={styles.current}>{page.next_cursor ? "Finding the creation record…" : page.items.length ? "The selected creation record is no longer available." : null}</p> : null}
      {page?.items.length ? (
        <ol className={styles.effectsList}>
          {page.items.map((effect) => (
            <li key={effect.position_id} className={styles.effect} ref={effect.position_id === positionId ? selectedRef : undefined} tabIndex={effect.position_id === positionId ? -1 : undefined} aria-current={effect.position_id === positionId ? "true" : undefined}>
              <div className={styles.effectHeading}>
                <strong>{effect.canonical_id.replace(/^nexus\./, "").replaceAll(".", " ")}</strong>
                <time dateTime={effect.created_at}>{new Date(effect.created_at).toLocaleString()}</time>
              </div>
              <p className={styles.effectStatus}>{effectStatus(effect, undone.has(effect.position_id))}</p>
              {effect.created_refs?.length ? (
                <ul className={styles.effectRefs}>
                  {effect.created_refs.map((ref, index) => (
                    <li key={`${String(ref.id)}-${index}`}>
                      {typeof ref.kind === "string" ? `${ref.kind}: ` : ""}
                      {typeof ref.label === "string" && ref.label.trim()
                        ? ref.label
                        : typeof ref.id === "string" ? ref.id : "created item"}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className={styles.effectProvenance}>Generation {effect.generation_id}</p>
              {effect.undo_allowed && effect.undo_url && !undone.has(effect.position_id) ? (
                <Button variant="ghost" size="sm" loading={busyId === effect.position_id} disabled={loading || loadingMore || busyId !== null} onClick={() => void undo(effect)}>Undo write</Button>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      {page?.next_cursor ? <Button variant="ghost" size="sm" loading={loadingMore} disabled={loading || busyId !== null} onClick={() => void loadMore()}>Load older writes</Button> : null}
    </PaneSection>
  );
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
  const searchParams = usePaneSearchParams();
  const generationId = searchParams.get("generation_id");
  const positionId = searchParams.get("position_id");
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

      <PaneSection title="Password">
        <p className={styles.current}>
          Set or replace the password used with your account email.
        </p>
        <Button asChild variant="secondary">
          <Link href="/account/password?next=%2Fsettings%2Faccount">
            Set or replace password
          </Link>
        </Button>
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
      <GenerationEffects key={`${generationId ?? "all"}:${positionId ?? ""}`} generationId={generationId} positionId={positionId} />
    </PaneSurface>
  );
}
