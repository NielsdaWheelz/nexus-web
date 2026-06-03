"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FeedbackNotice,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import SectionCard from "@/components/ui/SectionCard";
import Button from "@/components/ui/Button";
import { AppList, AppListItem } from "@/components/ui/AppList";
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
import styles from "./page.module.css";

const LOAD_FAILED_MESSAGE = "Failed to load identities";
const UNLINK_FAILED_MESSAGE =
  "We couldn't unlink this identity. Please try again.";
const KEEP_ONE_IDENTITY_MESSAGE =
  "Link at least one additional identity before unlinking.";

function linkedDate(identity: LinkedIdentity): string {
  if (!identity.createdAt) {
    return "linked date unavailable";
  }
  const date = new Date(identity.createdAt);
  if (Number.isNaN(date.getTime())) {
    return "linked date unavailable";
  }
  return `linked ${date.toLocaleDateString()}`;
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
    <SectionCard>
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
          <AppList>
            {identities.map((identity) => {
              const canUnlink = mayUnlinkIdentity(identities, identity.id);
              const pendingUnlink = unlinkingIdentityId === identity.id;

              return (
                <AppListItem
                  key={identity.id}
                  title={formatIdentityProvider(identity.provider)}
                  description={identity.email ?? "provider did not return an email"}
                  meta={linkedDate(identity)}
                  actions={
                    canUnlink ? (
                      <Button
                        variant="danger"
                        size="sm"
                        disabled={pendingUnlink}
                        onClick={() => void handleUnlinkIdentity(identity)}
                      >
                        {pendingUnlink ? "Unlinking..." : "Unlink"}
                      </Button>
                    ) : (
                      <span className={styles.unlinkHint}>Keep at least two identities.</span>
                    )
                  }
                />
              );
            })}
          </AppList>
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
    </SectionCard>
  );
}
