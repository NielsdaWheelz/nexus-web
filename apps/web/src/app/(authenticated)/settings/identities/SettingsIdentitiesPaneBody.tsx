"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  FeedbackNotice,
  toFeedback,
  type FeedbackContent,
} from "@/components/feedback/Feedback";
import SectionCard from "@/components/ui/SectionCard";
import Button from "@/components/ui/Button";
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
  const [error, setError] = useState<FeedbackContent | null>(null);
  const [notice, setNotice] = useState<FeedbackContent | null>(null);
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
      setError(toFeedback(identitiesError, { fallback: "Failed to load identities" }));
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
          redirectTo: buildAuthCallbackUrl(window.location.origin, "/settings/identities"),
        },
      });

      if (linkError) {
        setError(
          toFeedback(linkError, {
            fallback: "We couldn't start identity linking. Please try again.",
          })
        );
      }
    } catch (linkError) {
      setError(
        toFeedback(linkError, {
          fallback: "We couldn't start identity linking. Please try again.",
        })
      );
    } finally {
      setLinkingProvider(null);
    }
  }, []);

  const handleUnlinkIdentity = useCallback(
    async (identity: LinkedIdentity) => {
      if (!mayUnlinkIdentity(identities, identity.id)) {
        setError({ severity: "error", title: "Link at least one additional identity before unlinking." });
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
          setError(
            toFeedback(unlinkError, {
              fallback: "We couldn't unlink this identity. Please try again.",
            })
          );
          return;
        }

        setNotice({
          severity: "success",
          title: `${formatIdentityProvider(identity.provider)} sign-in was removed.`,
        });
        await loadIdentities();
      } catch (unlinkError) {
        setError(
          toFeedback(unlinkError, {
            fallback: "We couldn't unlink this identity. Please try again.",
          })
        );
      } finally {
        setUnlinkingIdentityId(null);
      }
    },
    [identities, loadIdentities]
  );

  return (
    <SectionCard>
      <div className={styles.content}>
        {loading && <FeedbackNotice severity="info">Loading identities...</FeedbackNotice>}
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

        {connectableProviders.length === 0 ? (
          <FeedbackNotice severity="success">
            Google and GitHub are already linked for this account.
          </FeedbackNotice>
        ) : (
          <div className={styles.linkButtons}>
            {connectableProviders.map((provider) => {
              const pending = linkingProvider === provider;
              return (
                <Button
                  key={provider}
                  variant="pill"
                  disabled={linkingProvider !== null || unlinkingIdentityId !== null}
                  onClick={() => void handleLinkProvider(provider)}
                >
                  {pending
                    ? `Redirecting to ${formatIdentityProvider(provider)}...`
                    : `Connect ${formatIdentityProvider(provider)}`}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </SectionCard>
  );
}
