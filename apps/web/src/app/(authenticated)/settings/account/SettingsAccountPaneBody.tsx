"use client";

import { useId, useState, type ComponentProps, type FormEvent } from "react";
import { Announcement, Hold, useOutcome } from "@/components/feedback/Feedback";
import { Failed, Field } from "@/components/feedback/Fact";
import type { Line } from "@/components/feedback/stage";
import { Check, Copy } from "lucide-react";
import { useCopyFeedback } from "@/components/ui/useCopyFeedback";
import Button from "@/components/ui/Button";
import { buttonClassName } from "@/components/ui/control";
import Input from "@/components/ui/Input";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import { apiFetch, isApiError, outcomeUnknown } from "@/lib/api/client";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import type { ApiJson } from "@/lib/api/wire";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { usePaneSearchParams } from "@/lib/panes/paneRuntime";
import { ClipboardWriteUnavailableError } from "@/lib/ui/copyText";
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
/** What a save leaves at its form: a refused input's line beneath the field, or an outcome it
 * cannot know, held until the next send, which is its retry. A slip took any other outcome. */
type Outcome =
  | { readonly kind: "Saved" }
  | { readonly kind: "Refused"; readonly line: Line }
  | { readonly kind: "Unknown" }
  | { readonly kind: "Told" };

const UNKNOWN: Line = { fact: "not sure that saved. it may have gone through." };
const VISIT = definePaneVisitDataKey<Visit<Profile>>("Settings.Account");
// the server owns the bound (python schemas/user.py DISPLAY_NAME_MAX_LENGTH)
const NAME_MAX = 100;

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
  const current = props.current;
  const draft = useResourceDraft<{ text: string | null; pending: boolean }>(
    `Settings.Account.${props.title}`,
    () => ({ text: null, pending: false }),
    value => ({
      changed: value.text !== null && (props.normalize ?? String)(value.text.trim()) !== current,
      unconfirmed: value.pending,
      stopsBrowserWork: false,
    }),
  );
  const setDraft = (text: string | null) => draft.set(value => ({ ...value, text }));
  const setPending = (pending: boolean) => draft.set(value => ({ ...value, pending }));
  const { pending } = draft.value;
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [unknown, setUnknown] = useState(0);
  const lineId = useId();
  const value = draft.value.text ?? current ?? "";
  const next = (props.normalize ?? String)(value.trim());
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    const saved = await props.save(next);
    setPending(false);
    setOutcome(saved);
    if (saved.kind === "Unknown") setUnknown(count => count + 1);
    if (saved.kind === "Saved") setDraft(null);
  };
  return (
    <PaneSection title={props.title}>
      <form className={styles.form} onSubmit={submit}>
        {outcome?.kind === "Unknown" && !pending ? <Hold id={`settings-account:${props.title}`} attempt={unknown} line={UNKNOWN} /> : null}
        <p className={styles.current}>
          Current: {props.current || "(not set)"}
        </p>
        <label className={styles.field}>
          <span className={styles.label}>{props.label}</span>
          <Input
            {...props.input}
            value={value}
            onChange={(event) => { setDraft(event.target.value); if (outcome?.kind === "Refused") setOutcome(null); }}
            disabled={props.current === null || pending}
            aria-describedby={outcome?.kind === "Refused" ? lineId : undefined}
          />
        </label>
        {outcome?.kind === "Refused" ? <Field id={lineId} line={outcome.line} /> : null}
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
  const { say, fail } = useOutcome();
  /** A refusal of the input is the field's; an unknown outcome holds; the rest is a slip. */
  const failed = (error: unknown, title: string, invalid?: Line): Outcome => {
    if (invalid && isApiError(error) && error.code === "E_INVALID_REQUEST") return { kind: "Refused", line: invalid };
    if (outcomeUnknown(error) && error.code !== "E_UNAUTHENTICATED") return { kind: "Unknown" };
    fail(error, title);
    return { kind: "Told" };
  };
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
  usePaneReturnReady(account.status !== "loading");
  const profile =
    account.status !== "ready"
      ? null
      : saved?.over === account.generation
        ? saved.profile
        : account.data;

  const copied = useCopyFeedback(profile?.email_ingest_address);
  // PATCH /me sets absolute values: a retry that already landed is a no-op success.
  const patch = async (
    body: { display_name: string | null } | { calendar_time_zone: string },
    title: string,
    invalid: Line,
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
      return { kind: "Saved" };
    } catch (error) {
      return failed(error, title, invalid);
    }
  };
  const changeEmail = async (email: string): Promise<Outcome> => {
    const title = "couldn’t update your email.";
    try {
      const { data: { outcome } } = installedApp
        ? await accountEmailChange(email)
        : await apiFetch<{ data: EmailChangeResult }>("/api/me/email-change", { method: "POST", body: JSON.stringify({ email }) });
      switch (outcome) {
        case "Sent":
          say({ fact: `check ${email} to confirm the change.`, reason: "your email changes when you follow its link." });
          return { kind: "Saved" };
        case "InUse": return { kind: "Refused", line: { fact: "another account already uses this email." } };
        case "Invalid": return { kind: "Refused", line: { fact: "enter a valid email address." } };
        case "Failed": say({ fact: title }); return { kind: "Told" };
      }
    } catch (error) {
      return failed(error, title);
    }
  };
  const copy = async (address: string) => {
    try {
      await copied.copy(address);
    } catch (error) {
      // The address stands as selectable text beside its copy control.
      if (error instanceof ClipboardWriteUnavailableError) say({ fact: "couldn’t copy the address.", reason: "select it to copy it." });
      else fail(error, "couldn’t copy the address.");
    }
  };

  return (
    <PaneSurface>
      {copied.occurrence ? <Announcement text="copied" level="Polite" occurrence={copied.occurrence} /> : null}
      {account.status === "failed" ? <Failed error={account.error} noun="account settings" retry={{ run: account.refetch, busy: account.retrying }} /> : null}
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
            "couldn’t update your display name.",
            { fact: `enter a display name of at most ${NAME_MAX} characters.` },
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
            "couldn’t update your calendar time zone.",
            { fact: "enter an IANA time zone, such as America/Los_Angeles." },
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
              icon={copied.copied ? <Check /> : <Copy />}
              onClick={() => void copy(profile.email_ingest_address ?? "")}
            >
              Copy address
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
