"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import CollectionView from "@/components/collections/CollectionView";
import Button from "@/components/ui/Button";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import SectionOpener from "@/components/ui/SectionOpener";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";
import { useResource } from "@/lib/api/useResource";
import {
  formatIdentityProvider,
  getConnectableProviders,
  mayUnlinkIdentity,
  type LinkedIdentity,
  type OAuthProvider,
} from "@/lib/auth/identities";
import {
  loadLinkedIdentities,
  unlinkLinkedIdentity,
} from "./actions";
import { PasswordRow } from "./PasswordRow";
import { formatDisplayDate } from "@/lib/display/format";
import { presentSettingsRow } from "@/lib/collections/presenters/settings";
import { useRenderEnvironment } from "@/lib/renderEnvironment/provider";
import type { RenderEnvironment } from "@/lib/renderEnvironment/types";
import { usePaneReturnReady } from "@/lib/panes/paneRuntime";
import styles from "./page.module.css";

const LOAD_FAILED_MESSAGE = "Failed to load identities";
const UNLINK_FAILED_MESSAGE =
  "We couldn't unlink this identity. Please try again.";
const KEEP_ONE_IDENTITY_MESSAGE =
  "Link at least one additional identity before unlinking.";

function linkedDate(identity: LinkedIdentity, display: RenderEnvironment): string {
  if (!identity.createdAt) {
    return "linked date unavailable";
  }
  const formatted = formatDisplayDate(identity.createdAt, display);
  return formatted ? `linked ${formatted}` : "linked date unavailable";
}

// Identity linking is OAuth initiation: a GET form to the server /auth/oauth
// route, which asks Supabase for the provider URL and redirects there. The
// browser never holds a Supabase client.
function ConnectProviderForm({ provider }: { provider: OAuthProvider }) {
  return (
    <form className={styles.linkForm} action="/auth/oauth" method="get">
      <input type="hidden" name="mode" value="link" />
      <input type="hidden" name="provider" value={provider} />
      <Button variant="pill" type="submit">
        {`Connect ${formatIdentityProvider(provider)}`}
      </Button>
    </form>
  );
}

export default function SettingsIdentitiesPaneBody() {
  const display = useRenderEnvironment();
  const initialIdentities = useResource({
    cacheKey: "settings-identities:list",
    load: () => loadLinkedIdentities(),
  });
  const [identities, setIdentities] = useState<LinkedIdentity[]>([]);
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
  const [unlinkingIdentityId, setUnlinkingIdentityId] = useState<string | null>(
    null
  );
  const loading = initialIdentities.status === "loading";
  usePaneReturnReady(
    initialIdentities.status === "ready" ||
      initialIdentities.status === "error",
  );

  // Imperative refresh after mutations (unlink, password change). The initial
  // load is owned by useResource above; this re-reads the server action.
  const loadIdentities = useCallback(async () => {
    const result = await loadLinkedIdentities();
    if (!result.ok) {
      setError({ severity: "error", title: LOAD_FAILED_MESSAGE });
      setIdentities([]);
      return;
    }

    setIdentities(result.identities);
    setError(null);
  }, []);

  useEffect(() => {
    if (initialIdentities.status !== "ready") return;
    if (initialIdentities.data.ok) {
      setIdentities(initialIdentities.data.identities);
      setError(null);
    } else {
      setError({ severity: "error", title: LOAD_FAILED_MESSAGE });
      setIdentities([]);
    }
  }, [initialIdentities]);

  const connectableProviders = useMemo(
    () => getConnectableProviders(identities),
    [identities]
  );

  const handleUnlinkIdentity = useCallback(
    async (identity: LinkedIdentity) => {
      if (!mayUnlinkIdentity(identities, identity.id)) {
        setError({ severity: "error", title: KEEP_ONE_IDENTITY_MESSAGE });
        return;
      }

      setError(null);
      setNotice(null);
      setUnlinkingIdentityId(identity.id);

      try {
        const result = await unlinkLinkedIdentity(
          identity.id,
          identity.provider
        );
        if (!result.ok) {
          setError({ severity: "error", title: UNLINK_FAILED_MESSAGE });
          return;
        }

        setNotice({
          severity: "success",
          title: `${formatIdentityProvider(identity.provider)} sign-in was removed.`,
        });
        await loadIdentities();
      } finally {
        setUnlinkingIdentityId(null);
      }
    },
    [identities, loadIdentities]
  );

  return (
    <PaneSurface opener={<SectionOpener heading="Linked Identities" />}>
      <PaneSection>
        <div className={styles.content}>
        {loading && <PaneLoadingState />}
        {error ? <FeedbackNotice feedback={error} /> : null}
        {notice ? <FeedbackNotice feedback={notice} /> : null}

        {!loading && identities.length === 0 && (
          <FeedbackNotice severity="neutral">
            No linked identities were found for this account.
          </FeedbackNotice>
        )}

        {!loading && identities.length > 0 && (
          <CollectionView
            returnScope="Settings.Identities.Linked"
            rows={identities.map((identity) => {
              const canUnlink = mayUnlinkIdentity(identities, identity.id);
              const pendingUnlink = unlinkingIdentityId === identity.id;
              return presentSettingsRow({
                id: identity.id,
                title: formatIdentityProvider(identity.provider),
                description: identity.email ?? "provider did not return an email",
                meta: linkedDate(identity, display),
                actions: canUnlink
                  ? [
                      {
                        kind: "command",
                        id: "unlink-identity",
                        label: pendingUnlink ? "Unlinking..." : "Unlink",
                        tone: "danger",
                        disabled: pendingUnlink,
                        onSelect: () => void handleUnlinkIdentity(identity),
                      },
                    ]
                  : [],
              });
            })}
            status="ready"
            ariaLabel="Linked identities"
            surface={false}
          />
        )}

        <PasswordRow identities={identities} onChanged={loadIdentities} />

        {connectableProviders.length === 0 ? (
          <FeedbackNotice severity="success">
            Google and GitHub are already linked for this account.
          </FeedbackNotice>
        ) : (
          <div className={styles.linkButtons}>
            {connectableProviders.map((provider) => (
              <ConnectProviderForm key={provider} provider={provider} />
            ))}
          </div>
        )}
        </div>
      </PaneSection>
    </PaneSurface>
  );
}
