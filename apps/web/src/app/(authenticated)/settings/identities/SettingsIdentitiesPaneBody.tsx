"use client";

import { UNKNOWN_OUTCOME_REASON } from "@/lib/api/failure";
import { Unlink } from "lucide-react";

import { useEffect } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { Hold, useOutcome, useResendFeedback } from "@/components/feedback/Feedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import ButtonLink from "@/components/ui/ButtonLink";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { apiFetch, isApiError, isSameSystemApiDefect, outcomeUnknown } from "@/lib/api/client";
import { useResourceDraft } from "@/lib/resourceGraph/useResourceDraft";
import { useServerValue, type Visit } from "@/lib/api/serverState";
import { OAUTH_PROVIDERS, oauthPath, PROVIDER_NAMES } from "@/lib/auth/urls";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { SettingsIdentity as LinkedIdentity, IdentityDeleteResult } from "@/lib/account/settingsWire";
import { installedApp } from "@/lib/native/admission";
import { accountIdentitiesGet, accountIdentityDelete } from "@/lib/native/client";
import { useAuthenticatedAccount } from "@/lib/account/authenticatedAccount";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import styles from "./page.module.css";

const VISIT = definePaneVisitDataKey<Visit<LinkedIdentity[]>>(
  "Settings.Identities",
);
type UnlinkCommand = { identity: LinkedIdentity; phase: "Sending" | "Unknown" | "Retrying"; attempt: number };
const UNLINK_FAILED = "couldn’t unlink this identity.";

async function readIdentities(): Promise<LinkedIdentity[]> {
  return (installedApp
    ? await accountIdentitiesGet()
    : await apiFetch<{ data: LinkedIdentity[] }>("/api/me/identities")).data;
}

/**
 * The viewer's Google and GitHub sign-in methods. Connect is OAuth initiation:
 * a link (not a GET form: chromium holds a form's whole redirect chain to the
 * csp's form-action 'self') to /auth/oauth, which redirects to the provider and
 * returns here. Unlink is offered only while two remain (I5); the action re-checks.
 */
export default function SettingsIdentitiesPaneBody() {
  const display = useRenderEnvironment();
  const { accountId } = useAuthenticatedAccount();
  const { fail } = useOutcome();
  const resendFeedback = useResendFeedback();
  const identities = useServerValue({
    key: "identities",
    stale: "",
    visit: VISIT,
    load: readIdentities,
  });
  const draft = useResourceDraft<{ command: UnlinkCommand | null }>("Settings.Identities.Unlink", () => ({ command: null }), value => ({
    changed: false, unconfirmed: value.command !== null, stopsBrowserWork: false,
  }));
  const command = draft.value.command;
  usePaneReturnReady(identities.status !== "loading");
  // This unfiltered successful read proves the idempotent delete's desired state.
  useEffect(() => {
    if (identities.status !== "ready" || identities.refreshing || identities.error !== null) return;
    const pending = draft.read().command;
    if (pending !== null && pending.phase !== "Sending" && !identities.data.some(identity => identity.id === pending.identity.id)) draft.set({ command: null });
  }, [identities, draft]);

  const unlink = async (identity: LinkedIdentity) => {
    const previous = draft.read().command;
    if (previous !== null && (previous.phase !== "Unknown" || previous.identity.id !== identity.id)) return;
    const running: UnlinkCommand = { identity: previous?.identity ?? identity, phase: previous === null ? "Sending" : "Retrying", attempt: previous?.attempt ?? 0 };
    draft.set({ command: running });
    try {
      const { data: { outcome } } = installedApp
        ? await accountIdentityDelete(running.identity.id)
        : await apiFetch<{ data: IdentityDeleteResult }>(`/api/me/identities/${encodeURIComponent(running.identity.id)}`, { method: "DELETE" });
      if (draft.read().command !== running) return;
      if (outcome === "Unlinked") { draft.set({ command: null }); void identities.refetch(); }
      // Failed includes provider silence after sending, so it proves no refusal.
      else draft.set({ command: { ...running, phase: "Unknown", attempt: running.attempt + 1 } });
    } catch (error) {
      if (draft.read().command !== running) return;
      if (previous !== null || outcomeUnknown(error)) {
        draft.set({ command: { ...running, phase: "Unknown", attempt: running.attempt + 1 } });
        if (!isApiError(error) || isSameSystemApiDefect(error)) fail(error, UNLINK_FAILED);
      } else { draft.set({ command: null }); fail(error, UNLINK_FAILED); }
    }
  };
  const held = command === null || command.phase === "Sending" ? null : resendFeedback({
    line: { fact: "not sure that saved.", reason: UNKNOWN_OUTCOME_REASON },
    resend: { label: "retry", commandKey: `UnlinkIdentity:${command.identity.id}`, busy: command.phase === "Retrying", run: () => { void unlink(command.identity); } },
  });

  const ready = identities.status === "ready" ? identities : null;
  const missing = OAUTH_PROVIDERS.filter(
    (provider) =>
      !ready?.data.some((identity) => identity.provider === provider),
  );
  return (
    <PaneSurface>
      <PaneSection>
        <div className={styles.content}>
          {identities.status === "loading" ? <Ruling />
            : identities.status === "failed" ? <Failed error={identities.error} noun="linked identities" retry={{ run: identities.refetch, busy: identities.retrying }} />
            : null}
          {held === null || command === null ? null : <Hold id={`${draft.owner}:unlink:${command.identity.id}`} attempt={command.attempt} {...held} />}
          {ready === null ? null : (
            <>
              {ready.data.length === 0 ? (
                <Fact line={{ fact: "no linked identities." }} />
              ) : (
                <CollectionView
                  returnScope="Settings.Identities.Linked"
                  ariaLabel="Linked identities"
                  status="ready"
                  surface={false}
                  rows={ready.data.map((identity) => {
                    const linkedOn = identity.created_at
                      ? formatDisplayDate(identity.created_at, display)
                      : null;
                    return presentSettingsRow({
                      presentation: "Details",
                      id: identity.id,
                      title: PROVIDER_NAMES[identity.provider],
                      description:
                        identity.email ?? "provider did not return an email",
                      meta: linkedOn
                        ? `linked ${linkedOn}`
                        : "linked date unavailable",
                      actions:
                        ready.data.length > 1
                          ? [
                              {
                                kind: "command",
                                id: "unlink-identity",
                                icon: <Unlink size={16} aria-hidden="true" />,
                                label: "Unlink",
                                tone: "danger",
                                disabled:
                                  command !== null || ready.refreshing,
                                onSelect: () => void unlink(identity),
                              },
                            ]
                          : [],
                    });
                  })}
                />
              )}
              {missing.length === 0 ? (
                <Fact line={{ fact: "every sign-in provider is linked." }} />
              ) : (
                <div className={styles.linkButtons}>
                  {missing.map((provider) => (
                    <ButtonLink key={provider} href={installedApp ? `/account/identities?expected_account_id=${encodeURIComponent(accountId)}` : oauthPath(provider, "link")}>
                      {`Connect ${PROVIDER_NAMES[provider]}`}
                    </ButtonLink>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </PaneSection>
    </PaneSurface>
  );
}
