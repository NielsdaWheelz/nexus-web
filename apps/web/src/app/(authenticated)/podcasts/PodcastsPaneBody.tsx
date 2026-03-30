"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MediaCatalogPage from "@/components/MediaCatalogPage";
import { apiFetch, isApiError } from "@/lib/api/client";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

const SUBSCRIPTION_PAGE_SIZE = 100;

interface PodcastDiscoveryItem {
  provider_podcast_id: string;
  title: string;
  author: string | null;
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
}

interface PodcastSubscribeResult {
  podcast_id: string;
  subscription_created: boolean;
  sync_status: "pending" | "running" | "partial" | "complete" | "source_limited" | "failed";
  sync_enqueued: boolean;
  sync_error_code: string | null;
  sync_error_message: string | null;
  sync_attempts: number;
  last_synced_at: string | null;
  window_size: number;
}

interface SubscriptionSnapshot {
  podcast_id: string;
  sync_status: PodcastSubscribeResult["sync_status"];
}

interface PodcastSubscriptionListRow {
  podcast_id: string;
  sync_status: PodcastSubscribeResult["sync_status"];
  podcast: {
    provider_podcast_id: string;
  };
}

export default function PodcastsPaneBody() {
  const [query, setQuery] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverResults, setDiscoverResults] = useState<PodcastDiscoveryItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [subscriptionByProviderId, setSubscriptionByProviderId] = useState<
    Record<string, SubscriptionSnapshot>
  >({});
  const [subscriptionsHydrated, setSubscriptionsHydrated] = useState(false);
  const [subscribingProviderIds, setSubscribingProviderIds] = useState<Set<string>>(new Set());

  const hydrateSubscriptions = useCallback(async () => {
    if (subscriptionsHydrated) {
      return;
    }
    const next: Record<string, SubscriptionSnapshot> = {};
    let offset = 0;

    while (true) {
      const response = await apiFetch<{ data: PodcastSubscriptionListRow[] }>(
        `/api/podcasts/subscriptions?limit=${SUBSCRIPTION_PAGE_SIZE}&offset=${offset}`
      );
      for (const row of response.data) {
        next[row.podcast.provider_podcast_id] = {
          podcast_id: row.podcast_id,
          sync_status: row.sync_status,
        };
      }
      if (response.data.length < SUBSCRIPTION_PAGE_SIZE) {
        break;
      }
      offset += SUBSCRIPTION_PAGE_SIZE;
    }

    setSubscriptionByProviderId(next);
    setSubscriptionsHydrated(true);
  }, [subscriptionsHydrated]);

  useEffect(() => {
    void hydrateSubscriptions().catch((error: unknown) => {
      if (isApiError(error)) {
        setDiscoverError(error.message);
      } else {
        setDiscoverError("Failed to load existing subscriptions");
      }
    });
  }, [hydrateSubscriptions]);

  const handleDiscover = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }

    setDiscovering(true);
    setDiscoverError(null);
    setHasSearched(true);

    try {
      await hydrateSubscriptions();
      const params = new URLSearchParams({ q: trimmed, limit: "10" });
      const response = await apiFetch<{ data: PodcastDiscoveryItem[] }>(
        `/api/podcasts/discover?${params.toString()}`
      );
      setDiscoverResults(response.data);
    } catch (error) {
      if (isApiError(error)) {
        setDiscoverError(error.message);
      } else {
        setDiscoverError("Podcast discovery failed");
      }
    } finally {
      setDiscovering(false);
    }
  };

  const handleSubscribe = async (item: PodcastDiscoveryItem) => {
    const providerPodcastId = item.provider_podcast_id;
    setSubscribingProviderIds((prev) => new Set(prev).add(providerPodcastId));
    setDiscoverError(null);
    try {
      const response = await apiFetch<{ data: PodcastSubscribeResult }>("/api/podcasts/subscriptions", {
        method: "POST",
        body: JSON.stringify({
          provider_podcast_id: item.provider_podcast_id,
          title: item.title,
          author: item.author,
          feed_url: item.feed_url,
          website_url: item.website_url,
          image_url: item.image_url,
          description: item.description,
        }),
      });
      setSubscriptionByProviderId((prev) => ({
        ...prev,
        [providerPodcastId]: {
          podcast_id: response.data.podcast_id,
          sync_status: response.data.sync_status,
        },
      }));
    } catch (error) {
      if (isApiError(error)) {
        setDiscoverError(error.message);
      } else {
        setDiscoverError("Podcast subscription failed");
      }
    } finally {
      setSubscribingProviderIds((prev) => {
        const next = new Set(prev);
        next.delete(providerPodcastId);
        return next;
      });
    }
  };

  return (
    <MediaCatalogPage
      title="Podcasts"
      description="Discover podcasts globally and review podcast episodes already in your libraries."
      allowedKinds={["podcast_episode"]}
      emptyMessage="No podcast episodes found in your visible libraries."
      headerSlot={
        <SectionCard
          title="Discover podcasts"
          description="Search global feeds, subscribe, and open podcast detail views."
          actions={
            <Link href="/podcasts/subscriptions" className={styles.subscriptionsLink}>
              My podcasts
            </Link>
          }
        >
          <form className={styles.discoveryForm} onSubmit={handleDiscover}>
            <input
              className={styles.input}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search podcasts by title or topic..."
            />
            <button
              type="submit"
              className={styles.searchButton}
              disabled={discovering || !query.trim()}
            >
              {discovering ? "Searching..." : "Search"}
            </button>
          </form>

          {discoverError && <StateMessage variant="error">{discoverError}</StateMessage>}

          {hasSearched && !discovering && discoverResults.length === 0 && (
            <StateMessage variant="empty">No podcasts found for this query.</StateMessage>
          )}

          {discoverResults.length > 0 && (
            <AppList>
              {discoverResults.map((result) => {
                const subscription = subscriptionByProviderId[result.provider_podcast_id];
                const isSubscribing = subscribingProviderIds.has(result.provider_podcast_id);
                return (
                  <AppListItem
                    key={result.provider_podcast_id}
                    href={subscription ? `/podcasts/${subscription.podcast_id}` : result.website_url || result.feed_url}
                    target={subscription ? undefined : "_blank"}
                    rel={subscription ? undefined : "noopener noreferrer"}
                    icon={<span className={styles.thumbnailFallback}>POD</span>}
                    title={result.title}
                    description={result.author || "Unknown author"}
                    meta={result.feed_url}
                    trailing={
                      subscription ? (
                        <span className={styles.subscriptionState}>{subscription.sync_status}</span>
                      ) : undefined
                    }
                    actions={
                      subscription ? (
                        <Link href={`/podcasts/${subscription.podcast_id}`} className={styles.viewPodcastLink}>
                          View podcast
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className={styles.subscribeButton}
                          disabled={isSubscribing}
                          onClick={() => void handleSubscribe(result)}
                        >
                          {isSubscribing ? "Subscribing..." : "Subscribe"}
                        </button>
                      )
                    }
                    options={[
                      ...(result.website_url
                        ? [
                            {
                              id: "open-website",
                              label: "Open website",
                              href: result.website_url,
                            },
                          ]
                        : []),
                      ...(result.feed_url
                        ? [
                            {
                              id: "open-feed",
                              label: "Open feed",
                              href: result.feed_url,
                            },
                          ]
                        : []),
                    ]}
                  />
                );
              })}
            </AppList>
          )}
        </SectionCard>
      }
    />
  );
}
