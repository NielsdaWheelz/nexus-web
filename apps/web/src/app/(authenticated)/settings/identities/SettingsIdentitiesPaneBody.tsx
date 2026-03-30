"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import {
  formatIdentityProvider,
  getConnectableProviders,
  mayUnlinkIdentity,
  normalizeLinkedIdentities,
  type LinkedIdentity,
  type OAuthProvider,
} from "@/lib/auth/identities";
import { buildAuthCallbackUrl } from "@/lib/auth/redirects";
import { createClient } from "@/lib/supabase/client";
import styles from "./page.module.css";

const LINKING_RETURN_PATH = "/settings/identities";

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

export default function SettingsIdentitiesPaneBody() {
  const [identities, setIdentities] = useState<LinkedIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkingProvider, setLinkingProvider] = useState<OAuthProvider | null>(
    null
  );
  const [unlinkingIdentityId, setUnlinkingIdentityId] = useState<string | null>(
    null
  );

  const loadIdentities = useCallback(async () => {
    const supabase = createClient();
    const { data, error: identitiesError } = await supabase.auth.getUserIdentities();
    if (identitiesError) {
      setError(identitiesError.message);
      setIdentities([]);
      return;
    }

    setIdentities(normalizeLinkedIdentities(data));
    setError(null);
  }, []);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      await loadIdentities();
      setLoading(false);
    })();
  }, [loadIdentities]);

  const connectableProviders = useMemo(
    () => getConnectableProviders(identities),
    [identities]
  );

  const handleLinkProvider = useCallback(async (provider: OAuthProvider) => {
    setError(null);
    setNotice(null);
    setLinkingProvider(provider);

    try {
      const supabase = createClient();
      const { error: linkError } = await supabase.auth.linkIdentity({
        provider,
        options: {
          redirectTo: buildAuthCallbackUrl(window.location.origin, LINKING_RETURN_PATH),
        },
      });

      if (linkError) {
        setError(linkError.message);
      }
    } catch {
      setError("We couldn't start identity linking. Please try again.");
    } finally {
      setLinkingProvider(null);
    }
  }, []);

  const handleUnlinkIdentity = useCallback(
    async (identity: LinkedIdentity) => {
      if (!mayUnlinkIdentity(identities, identity.id)) {
        setError("Link at least one additional identity before unlinking.");
        return;
      }

      setError(null);
      setNotice(null);
      setUnlinkingIdentityId(identity.id);

      try {
        const supabase = createClient();
        const unlinkPayload = {
          identity_id: identity.id,
          provider: identity.provider,
        } as Parameters<typeof supabase.auth.unlinkIdentity>[0];
        const { error: unlinkError } = await supabase.auth.unlinkIdentity(
          unlinkPayload
        );

        if (unlinkError) {
          setError(unlinkError.message);
          return;
        }

        setNotice(`${formatIdentityProvider(identity.provider)} sign-in was removed.`);
        await loadIdentities();
      } catch {
        setError("We couldn't unlink this identity. Please try again.");
      } finally {
        setUnlinkingIdentityId(null);
      }
    },
    [identities, loadIdentities]
  );

  return (
    <>
      <SectionCard
        title="Connected identities"
        description="Manual linking enables a single account to carry identities with different provider emails."
      >
        {loading && <StateMessage variant="loading">Loading identities...</StateMessage>}
        {error && <StateMessage variant="error">{error}</StateMessage>}
        {notice && <StateMessage variant="success">{notice}</StateMessage>}

        {!loading && identities.length === 0 && (
          <StateMessage variant="empty">
            No linked identities were found for this account.
          </StateMessage>
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
                      <button
                        type="button"
                        className={styles.unlinkButton}
                        disabled={pendingUnlink}
                        onClick={() => void handleUnlinkIdentity(identity)}
                      >
                        {pendingUnlink ? "Unlinking..." : "Unlink"}
                      </button>
                    ) : (
                      <span className={styles.unlinkHint}>Keep at least two identities.</span>
                    )
                  }
                />
              );
            })}
          </AppList>
        )}
      </SectionCard>

      <SectionCard
        title="Link another provider"
        description="Connect both Google and GitHub if you intentionally use different provider emails."
      >
        {connectableProviders.length === 0 ? (
          <StateMessage variant="success">
            Google and GitHub are already linked for this account.
          </StateMessage>
        ) : (
          <div className={styles.linkButtons}>
            {connectableProviders.map((provider) => {
              const pending = linkingProvider === provider;
              return (
                <button
                  key={provider}
                  type="button"
                  className={styles.linkButton}
                  disabled={linkingProvider !== null || unlinkingIdentityId !== null}
                  onClick={() => void handleLinkProvider(provider)}
                >
                  {pending
                    ? `Redirecting to ${formatIdentityProvider(provider)}...`
                    : `Connect ${formatIdentityProvider(provider)}`}
                </button>
              );
            })}
          </div>
        )}
      </SectionCard>
    </>
  );
}
