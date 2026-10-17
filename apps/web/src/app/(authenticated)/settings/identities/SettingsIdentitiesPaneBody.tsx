"use client";

import { useState } from "react";
import CollectionView from "@/components/collections/CollectionView";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { ApiError, apiTransportFeedback } from "@/lib/api/client";
import {
  modeledApiError,
  useServerValue,
  useThrowLater,
  type Visit,
} from "@/lib/api/serverState";
import { OAUTH_PROVIDERS, oauthPath, PROVIDER_NAMES } from "@/lib/auth/urls";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import { formatDisplayDate } from "@/lib/display/format";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { LinkedIdentity } from "@/lib/supabase/auth";
import {
  definePaneVisitDataKey,
  usePaneReturnReady,
} from "@/lib/workspace/paneReturnMemento";
import { runSettingsAction } from "../settingsAction";
import { loadLinkedIdentities, unlinkLinkedIdentity } from "./actions";
import styles from "./page.module.css";

const VISIT = definePaneVisitDataKey<Visit<LinkedIdentity[]>>(
  "Settings.Identities",
);
const LOAD_FAILED = "Linked identities couldn’t be loaded";
const UNLINK_FAILED = "We couldn't unlink this identity. Please try again.";

async function readIdentities(): Promise<LinkedIdentity[]> {
  const identities = await runSettingsAction(loadLinkedIdentities);
  if (identities === "Failed")
    throw new ApiError(503, "E_AUTH_UNAVAILABLE", "Identities are unavailable");
  return identities;
}

/**
 * The viewer's Google and GitHub sign-in methods. Connect is OAuth initiation:
 * a link (not a GET form: chromium holds a form's whole redirect chain to the
 * csp's form-action 'self') to /auth/oauth, which redirects to the provider and
 * returns here. Unlink is offered only while two remain (I5); the action re-checks.
 */
export default function SettingsIdentitiesPaneBody() {
  const display = useRenderEnvironment();
  const fail = useThrowLater();
  const identities = useServerValue({
    key: "identities",
    stale: "",
    visit: VISIT,
    load: readIdentities,
  });
  const [unlinking, setUnlinking] = useState<string | null>(null);
  const [failure, setFailure] = useState<FeedbackContent | null>(null);
  usePaneReturnReady(identities.status !== "loading");

  const unlink = async (identity: LinkedIdentity) => {
    setUnlinking(identity.id);
    setFailure(null);
    try {
      const outcome = await runSettingsAction(() =>
        unlinkLinkedIdentity(identity.id, identity.provider),
      );
      if (outcome === "Unlinked") identities.refetch();
      else setFailure({ tone: "Danger", title: UNLINK_FAILED });
    } catch (error) {
      const modeled = modeledApiError(error, fail);
      if (modeled !== null)
        setFailure(
          apiTransportFeedback(modeled, UNLINK_FAILED) ?? {
            tone: "Danger",
            title: UNLINK_FAILED,
          },
        );
    } finally {
      setUnlinking(null);
    }
  };

  const loadError = identities.status === "loading" ? null : identities.error;
  const ready = identities.status === "ready" ? identities : null;
  const missing = OAUTH_PROVIDERS.filter(
    (provider) =>
      !ready?.data.some((identity) => identity.provider === provider),
  );
  return (
    <PaneSurface>
      <PaneSection>
        <div className={styles.content}>
          {identities.status === "loading" ? (
            <PaneLoadingState
              label="Loading identities…"
              announcement="Polite"
            />
          ) : null}
          {loadError ? (
            <FeedbackNotice
              content={
                apiTransportFeedback(loadError, LOAD_FAILED) ?? {
                  tone: "Danger",
                  title: LOAD_FAILED,
                  requestId: loadError.requestId,
                }
              }
              announcement="Assertive"
              actions={[{ label: "Retry", onClick: identities.refetch, busy: identities.status === "failed" ? identities.retrying : identities.status === "ready" && identities.refreshing }]}
            />
          ) : null}
          {failure ? (
            <FeedbackNotice content={failure} announcement="Assertive" />
          ) : null}
          {ready === null ? null : (
            <>
              {ready.data.length === 0 ? (
                <FeedbackNotice
                  content={{
                    tone: "Neutral",
                    title: "No Google or GitHub identities are linked.",
                  }}
                  announcement="Polite"
                />
              ) : (
                <CollectionView
                  returnScope="Settings.Identities.Linked"
                  ariaLabel="Linked identities"
                  status="ready"
                  surface={false}
                  rows={ready.data.map((identity) => {
                    const linkedOn = identity.createdAt
                      ? formatDisplayDate(identity.createdAt, display)
                      : null;
                    return presentSettingsRow({
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
                                label:
                                  unlinking === identity.id
                                    ? "Unlinking..."
                                    : "Unlink",
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
                <FeedbackNotice
                  content={{
                    tone: "Neutral",
                    title:
                      "Google and GitHub are already linked for this account.",
                  }}
                  announcement="None"
                />
              ) : (
                <div className={styles.linkButtons}>
                  {missing.map((provider) => (
                    <Button key={provider} asChild variant="pill">
                      <a href={oauthPath(provider, "link")} role="button">
                        {`Connect ${PROVIDER_NAMES[provider]}`}
                      </a>
                    </Button>
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
