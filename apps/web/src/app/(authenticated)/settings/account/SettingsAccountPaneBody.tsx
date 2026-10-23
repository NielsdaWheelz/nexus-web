"use client";

import { useEffect, useId, useState, type ComponentProps, type FormEvent } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import { buttonClassName } from "@/components/ui/control";
import Input from "@/components/ui/Input";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, apiTransportFeedback } from "@/lib/api/client";
import {
  modeledApiError,
  useServerValue,
  useThrowLater,
  type Visit,
} from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { useWorkGuard } from "@/lib/unsavedWork";
import { usePaneRuntime, usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { ClipboardWriteUnavailableError, copyText } from "@/lib/ui/copyText";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import { installedApp } from "@/lib/native/admission";
import { accountEmailChange } from "@/lib/native/client";
import { useSettingsRefresh } from "@/lib/native/settingsRefresh";
import type { EmailChangeResult } from "@/lib/account/settingsWire";
import AssistantWrites from "./AssistantWrites";
import styles from "./page.module.css";

type Profile = ApiJson<"/me", "get">["data"];
/** What a save tells its form: feedback, and whether the field shows the saved value again. */
type Outcome = {
  readonly feedback: FeedbackContent | null;
  readonly done: boolean;
};

const VISIT = definePaneVisitDataKey<Visit<Profile>>("Settings.Account");
// the server owns the bound (python schemas/user.py DISPLAY_NAME_MAX_LENGTH)
const NAME_MAX = 100;

/** A failed command's feedback; null when the shell took it (sign-in, defect). */
function failure(
  error: unknown,
  fail: (defect: { error: unknown }) => void,
  title: string,
  invalid?: string,
): Outcome {
  const modeled = modeledApiError(error, fail);
  if (modeled === null) return { feedback: null, done: false };
  const { requestId } = modeled;
  const feedback =
    invalid && modeled.code === "E_INVALID_REQUEST"
      ? { tone: "Danger" as const, title, message: invalid, requestId }
      : (apiTransportFeedback(modeled, title) ?? {
          tone: "Danger" as const,
          title,
          requestId,
        });
  return { feedback, done: false };
}

/** One profile field: its current value, a draft, and a save. */
function ProfileForm(props: {
  readonly title: string;
  readonly label: string;
  /** null until the profile has loaded */
  readonly current: string | null;
  readonly input: Pick<
    ComponentProps<typeof Input>,
    "type" | "autoComplete" | "required"
  >;
  readonly normalize?: (value: string) => string;
  readonly hint?: string;
  readonly submit: string;
  readonly save: (value: string) => Promise<Outcome>;
}) {
  const guard = useWorkGuard();
  const pane = usePaneRuntime();
  const ownerId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackContent | null>(null);
  const value = draft ?? props.current ?? "";
  const next = (props.normalize ?? String)(value.trim());
  useEffect(() => guard.register({
    id: `settings-field:${ownerId}`,
    scope: pane ? { kind: "visit", visitId: pane.visitId, routeKey: pane.routeKey } : { kind: "account" },
    read: () => ({ changed: draft !== null && next !== props.current, unconfirmed: pending, stopsBrowserWork: false }),
    subscribe: () => () => {},
  }), [guard, ownerId, pane, draft, next, props.current, pending]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setFeedback(null);
    const outcome = await props.save(next);
    setPending(false);
    setFeedback(outcome.feedback);
    if (outcome.done) setDraft(null);
  };
  return (
    <PaneSection title={props.title}>
      <form className={styles.form} onSubmit={submit}>
        {feedback ? (
          <FeedbackNotice
            content={feedback}
            announcement={feedback.tone === "Info" ? "Polite" : "Assertive"}
          />
        ) : null}
        <p className={styles.current}>
          Current: {props.current || "(not set)"}
        </p>
        <label className={styles.field}>
          <span className={styles.label}>{props.label}</span>
          <Input
            {...props.input}
            value={value}
            onChange={(event) => setDraft(event.target.value)}
            disabled={props.current === null || pending}
          />
        </label>
        {props.hint ? <p className={styles.current}>{props.hint}</p> : null}
        <Button
          type="submit"
          emphasis="strong"
          aria-busy={pending || undefined}
          disabled={
            pending ||
            props.current === null ||
            next === props.current ||
            (props.input.required && !next)
          }
        >
          {props.submit}
        </Button>
      </form>
    </PaneSection>
  );
}

export default function SettingsAccountPaneBody() {
  const params = usePaneSearchParams();
  const generationId = params.get("generation_id");
  const toolCallId = params.get("tool_call_id");
  const refreshSettings = useSettingsRefresh();
  const { accountId, setCalendarTimeZone } = useAuthenticatedAccount();
  const fail = useThrowLater();
  const account = useServerValue({
    key: "/me",
    stale: "",
    visit: VISIT,
    load: async (signal) =>
      (await apiFetch<ApiJson<"/me", "get">>("/api/me", { signal })).data,
  });
  // a save's answer stands until the next read of /me, which the save asks for
  // at once: the visit snapshot holds reads, and a pane return restores it
  const [saved, setSaved] = useState<{ profile: Profile; over: number } | null>(
    null,
  );
  const [copied, setCopied] = useState<"Copied" | "Copy failed" | null>(null);
  usePaneReturnReady(account.status !== "loading");
  const profile =
    account.status !== "ready"
      ? null
      : saved?.over === account.generation
        ? saved.profile
        : account.data;

  // PATCH /me sets absolute values: a retry that already landed is a no-op success.
  const patch = async (
    body: { display_name: string | null } | { calendar_time_zone: string },
    title: string,
    invalid: string,
  ): Promise<Outcome> => {
    const over = account.status === "ready" ? account.generation : -1;
    try {
      const response = await apiFetch<ApiJson<"/me", "patch">>("/api/me", {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setSaved({ profile: response.data, over });
      account.refetch();
      if ("calendar_time_zone" in body)
        setCalendarTimeZone(response.data.calendar_time_zone);
      if ("calendar_time_zone" in body) void refreshSettings();
      return { feedback: null, done: true };
    } catch (error) {
      return failure(error, fail, title, invalid);
    }
  };
  const changeEmail = async (email: string): Promise<Outcome> => {
    const title = "We couldn't update your email. Please try again.";
    try {
      const { data: { outcome } } = installedApp
        ? await accountEmailChange(email)
        : await apiFetch<{ data: EmailChangeResult }>("/api/me/email-change", { method: "POST", body: JSON.stringify({ email }) });
      if (outcome === "Sent")
        return {
          feedback: {
            tone: "Info",
            title: `Check ${email} to confirm the change.`,
            message: "Your email changes when you follow the link in it.",
          },
          done: true,
        };
      const reason =
        outcome === "InUse"
          ? "An account with that email already exists."
          : outcome === "Invalid"
            ? "Enter a valid email address."
            : title;
      return { feedback: { tone: "Danger", title: reason }, done: false };
    } catch (error) {
      return failure(error, fail, title);
    }
  };
  const copy = async (address: string) => {
    try {
      await copyText(address);
      setCopied("Copied");
      setTimeout(() => setCopied(null), 2000);
    } catch (error) {
      if (!(error instanceof ClipboardWriteUnavailableError)) fail({ error });
      else setCopied("Copy failed");
    }
  };

  const loadTitle = "Account settings couldn’t be loaded";
  const loadError = account.status === "loading" ? null : account.error;
  return (
    <PaneSurface>
      {loadError ? (
        <FeedbackNotice
          content={
            apiTransportFeedback(loadError, loadTitle) ?? {
              tone: "Danger",
              title: loadTitle,
              requestId: loadError.requestId,
            }
          }
          announcement="Assertive"
          actions={[{ label: "Retry", onClick: account.refetch, busy: account.status === "failed" ? account.retrying : account.status === "ready" && account.refreshing }]}
        />
      ) : null}
      <ProfileForm
        title="Email"
        label="New email"
        current={profile && (profile.email ?? "")}
        input={{ type: "email", autoComplete: "email", required: true }}
        normalize={(value) => value.toLowerCase()}
        submit="Update email"
        save={changeEmail}
      />
      <PaneSection title="Password">
        <p className={styles.current}>
          Set or replace the password used with your account email.
        </p>
        <a href={installedApp ? `/account/password?expected_account_id=${encodeURIComponent(accountId)}&next=%2Fsettings%2Faccount` : "/account/password?next=%2Fsettings%2Faccount"} className={buttonClassName({})}>
          Set or replace password
        </a>
      </PaneSection>
      <ProfileForm
        title="Display name"
        label="New display name"
        current={profile && (profile.display_name ?? "")}
        input={{ type: "text", autoComplete: "name" }}
        submit="Update display name"
        save={(name) =>
          patch(
            { display_name: name || null },
            "We couldn't update your display name. Please try again.",
            `Enter a display name of at most ${NAME_MAX} characters.`,
          )
        }
      />
      <ProfileForm
        title="Calendar time zone"
        label="Calendar time zone"
        current={profile && profile.calendar_time_zone}
        input={{ type: "text", autoComplete: "off", required: true }}
        hint="Use an IANA time zone, for example America/Los_Angeles."
        submit="Update calendar time zone"
        save={(zone) =>
          patch(
            { calendar_time_zone: zone },
            "Calendar time zone couldn’t be updated",
            "Enter an IANA time zone such as America/Los_Angeles.",
          )
        }
      />
      <PaneSection title="Post Room">
        {profile === null ? null : profile.email_ingest_address ? (
          <>
            <p className={styles.current}>
              <code>{profile.email_ingest_address}</code>
            </p>
            <Button
              onClick={() => void copy(profile.email_ingest_address ?? "")}
            >
              {copied ?? "Copy address"}
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
      <AssistantWrites
        key={`${generationId ?? "all"}:${toolCallId ?? "none"}`}
        generationId={generationId}
        toolCallId={toolCallId}
      />
    </PaneSurface>
  );
}
