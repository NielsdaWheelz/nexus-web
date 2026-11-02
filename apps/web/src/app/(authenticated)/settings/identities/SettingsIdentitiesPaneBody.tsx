"use client";

import { Unlink } from "lucide-react";

import { useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import { Fact, Failed } from "@/components/feedback/Fact";
import { Ruling } from "@/components/feedback/Ruling";
import ButtonLink from "@/components/ui/ButtonLink";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { apiFetch, outcomeUnknown } from "@/lib/api/client";
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
  const { say, fail } = useOutcome();
  const identities = useServerValue({
    key: "identities",
    stale: "",
    visit: VISIT,
    load: readIdentities,
  });
  const [unlinking, setUnlinking] = useState<string | null>(null);
  // The row's `Unlink` is an unknown outcome's retry.
  const [unknown, setUnknown] = useState<{ id: string; attempt: number } | null>(null);
  usePaneReturnReady(identities.status !== "loading");

  const unlink = async (identity: LinkedIdentity) => {
    setUnlinking(identity.id);
    try {
      const { data: { outcome } } = installedApp
        ? await accountIdentityDelete(identity.id)
        : await apiFetch<{ data: IdentityDeleteResult }>(`/api/me/identities/${encodeURIComponent(identity.id)}`, { method: "DELETE" });
      setUnknown(null);
      if (outcome === "Unlinked") identities.refetch();
      else say({ fact: UNLINK_FAILED });
    } catch (error) {
      if (outcomeUnknown(error) && error.code !== "E_UNAUTHENTICATED") setUnknown(current => ({ id: identity.id, attempt: current?.id === identity.id ? current.attempt + 1 : 0 }));
      else { setUnknown(null); fail(error, UNLINK_FAILED); }
    } finally {
      setUnlinking(null);
    }
  };

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
          {unknown === null ? null : <Hold id={`unlink-identity:${unknown.id}`} attempt={unknown.attempt} line={{ fact: "not sure that saved. it may have gone through." }} />}
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
                                  unlinking !== null || ready.refreshing,
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
