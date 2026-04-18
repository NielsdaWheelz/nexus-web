"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import MediaCatalogPage from "@/components/MediaCatalogPage";
import LibraryTargetPicker, {
  type LibraryTargetPickerItem,
} from "@/components/LibraryTargetPicker";
import { apiFetch, isApiError } from "@/lib/api/client";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

const SUBSCRIPTION_PAGE_SIZE = 100;

interface LibrarySummary {
  id: string;
  name: string;
  is_default: boolean;
  color?: string | null;
}

interface PodcastDiscoveryItem {
  podcast_id: string | null;
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
  sync_status:
    | "pending"
    | "running"
    | "partial"
    | "complete"
    | "source_limited"
    | "failed";
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
  const [subscribingProviderIds, setSubscribingProviderIds] = useState<Set<string>>(
    new Set()
  );
  const [availableLibraries, setAvailableLibraries] = useState<
    LibraryTargetPickerItem[]
  >([]);
  const [availableLibrariesLoading, setAvailableLibrariesLoading] = useState(false);
  const [availableLibrariesLoaded, setAvailableLibrariesLoaded] = useState(false);
  const [librariesByPodcastId, setLibrariesByPodcastId] = useState<
    Record<string, LibraryTargetPickerItem[]>
  >({});
  const [loadingLibraryPodcastIds, setLoadingLibraryPodcastIds] = useState<Set<string>>(
    new Set()
  );
  const [busyLibraryMembershipKeys, setBusyLibraryMembershipKeys] = useState<Set<string>>(
    new Set()
  );

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

  const loadAvailableLibraries = useCallback(async () => {
    if (availableLibrariesLoading || availableLibrariesLoaded) {
      return;
    }
    setAvailableLibrariesLoading(true);
    try {
      const response = await apiFetch<{ data: LibrarySummary[] }>("/api/libraries");
      setAvailableLibraries(
        response.data
          .filter((library) => !library.is_default)
          .map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color ?? null,
            isInLibrary: false,
            canAdd: true,
            canRemove: false,
          }))
      );
      setAvailableLibrariesLoaded(true);
    } catch (error) {
      if (isApiError(error)) {
        setDiscoverError(error.message);
      } else {
        setDiscoverError("Failed to load libraries");
      }
      setAvailableLibraries([]);
    } finally {
      setAvailableLibrariesLoading(false);
    }
  }, [availableLibrariesLoaded, availableLibrariesLoading]);

  const loadPodcastLibraries = useCallback(
    async (podcastId: string) => {
      if (loadingLibraryPodcastIds.has(podcastId) || librariesByPodcastId[podcastId]) {
        return;
      }
      setLoadingLibraryPodcastIds((prev) => new Set(prev).add(podcastId));
      setDiscoverError(null);
      try {
        const response = await apiFetch<{
          data: Array<{
            id: string;
            name: string;
            color: string | null;
            is_in_library: boolean;
            can_add: boolean;
            can_remove: boolean;
          }>;
        }>(`/api/podcasts/${podcastId}/libraries`);
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: response.data.map((library) => ({
            id: library.id,
            name: library.name,
            color: library.color,
            isInLibrary: library.is_in_library,
            canAdd: library.can_add,
            canRemove: library.can_remove,
          })),
        }));
      } catch (error) {
        if (isApiError(error)) {
          setDiscoverError(error.message);
        } else {
          setDiscoverError("Failed to load podcast libraries");
        }
      } finally {
        setLoadingLibraryPodcastIds((prev) => {
          const next = new Set(prev);
          next.delete(podcastId);
          return next;
        });
      }
    },
    [librariesByPodcastId, loadingLibraryPodcastIds]
  );

  useEffect(() => {
    void hydrateSubscriptions().catch((error: unknown) => {
      if (isApiError(error)) {
        setDiscoverError(error.message);
      } else {
        setDiscoverError("Failed to load existing subscriptions");
      }
    });
    void loadAvailableLibraries();
  }, [hydrateSubscriptions, loadAvailableLibraries]);

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

  const handleSubscribe = useCallback(
    async (item: PodcastDiscoveryItem, libraryId: string | null = null) => {
      const providerPodcastId = item.provider_podcast_id;
      setSubscribingProviderIds((prev) => new Set(prev).add(providerPodcastId));
      setDiscoverError(null);
      try {
        const response = await apiFetch<{ data: PodcastSubscribeResult }>(
          "/api/podcasts/subscriptions",
          {
            method: "POST",
            body: JSON.stringify({
              provider_podcast_id: item.provider_podcast_id,
              title: item.title,
              author: item.author,
              feed_url: item.feed_url,
              website_url: item.website_url,
              image_url: item.image_url,
              description: item.description,
              library_id: libraryId,
            }),
          }
        );
        setSubscriptionByProviderId((prev) => ({
          ...prev,
          [providerPodcastId]: {
            podcast_id: response.data.podcast_id,
            sync_status: response.data.sync_status,
          },
        }));
        setDiscoverResults((prev) =>
          prev.map((result) =>
            result.provider_podcast_id === providerPodcastId
              ? { ...result, podcast_id: response.data.podcast_id }
              : result
          )
        );
        if (libraryId) {
          setLibrariesByPodcastId((prev) => ({
            ...prev,
            [response.data.podcast_id]: availableLibraries.map((library) =>
              library.id === libraryId
                ? {
                    ...library,
                    isInLibrary: true,
                    canAdd: false,
                    canRemove: true,
                  }
                : library
            ),
          }));
        }
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
    },
    [availableLibraries]
  );

  const handleAddPodcastToLibrary = useCallback(async (podcastId: string, libraryId: string) => {
    const busyKey = `${libraryId}:${podcastId}`;
    setBusyLibraryMembershipKeys((prev) => new Set(prev).add(busyKey));
    setDiscoverError(null);
    try {
      await apiFetch(`/api/libraries/${libraryId}/podcasts`, {
        method: "POST",
        body: JSON.stringify({ podcast_id: podcastId }),
      });
      setLibrariesByPodcastId((prev) => ({
        ...prev,
        [podcastId]: (prev[podcastId] ?? []).map((library) =>
          library.id === libraryId
            ? {
                ...library,
                isInLibrary: true,
                canAdd: false,
                canRemove: true,
              }
            : library
        ),
      }));
    } catch (error) {
      if (isApiError(error)) {
        setDiscoverError(error.message);
      } else {
        setDiscoverError("Failed to add podcast to library");
      }
    } finally {
      setBusyLibraryMembershipKeys((prev) => {
        const next = new Set(prev);
        next.delete(busyKey);
        return next;
      });
    }
  }, []);

  const handleRemovePodcastFromLibrary = useCallback(
    async (podcastId: string, libraryId: string) => {
      const busyKey = `${libraryId}:${podcastId}`;
      setBusyLibraryMembershipKeys((prev) => new Set(prev).add(busyKey));
      setDiscoverError(null);
      try {
        await apiFetch(`/api/libraries/${libraryId}/podcasts/${podcastId}`, {
          method: "DELETE",
        });
        setLibrariesByPodcastId((prev) => ({
          ...prev,
          [podcastId]: (prev[podcastId] ?? []).map((library) =>
            library.id === libraryId
              ? {
                  ...library,
                  isInLibrary: false,
                  canAdd: true,
                  canRemove: false,
                }
              : library
          ),
        }));
      } catch (error) {
        if (isApiError(error)) {
          setDiscoverError(error.message);
        } else {
          setDiscoverError("Failed to remove podcast from library");
        }
      } finally {
        setBusyLibraryMembershipKeys((prev) => {
          const next = new Set(prev);
          next.delete(busyKey);
          return next;
        });
      }
    },
    []
  );

  return (
    <MediaCatalogPage
      title="Podcasts"
      allowedKinds={["podcast_episode"]}
      emptyMessage="No podcast episodes found in your visible libraries."
      headerSlot={
        <SectionCard
          title="Discover podcasts"
          description="Search global feeds, open podcast detail views, and subscribe."
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
                const podcastId = subscription?.podcast_id ?? result.podcast_id;
                const isSubscribing = subscribingProviderIds.has(result.provider_podcast_id);
                const pickerLibraries = podcastId
                  ? (librariesByPodcastId[podcastId] ?? []).map((library) => {
                      const busyKey = `${library.id}:${podcastId}`;
                      if (!busyLibraryMembershipKeys.has(busyKey)) {
                        return library;
                      }
                      return {
                        ...library,
                        canAdd: false,
                        canRemove: false,
                      };
                    })
                  : [];

                return (
                  <AppListItem
                    key={result.provider_podcast_id}
                    href={
                      podcastId
                        ? `/podcasts/${podcastId}`
                        : result.website_url || result.feed_url
                    }
                    target={podcastId ? undefined : "_blank"}
                    rel={podcastId ? undefined : "noopener noreferrer"}
                    icon={<span className={styles.thumbnailFallback}>POD</span>}
                    title={result.title}
                    description={result.author || "Unknown author"}
                    meta={result.feed_url}
                    trailing={
                      subscription ? (
                        <span className={styles.subscriptionState}>
                          {subscription.sync_status}
                        </span>
                      ) : undefined
                    }
                    actions={
                      subscription && podcastId ? (
                        <>
                          <Link
                            href={`/podcasts/${podcastId}`}
                            className={styles.viewPodcastLink}
                          >
                            View podcast
                          </Link>
                          <LibraryTargetPicker
                            label="Libraries"
                            libraries={pickerLibraries}
                            loading={loadingLibraryPodcastIds.has(podcastId)}
                            onOpen={() => {
                              void loadPodcastLibraries(podcastId);
                            }}
                            onAddToLibrary={(libraryId) => {
                              void handleAddPodcastToLibrary(podcastId, libraryId);
                            }}
                            onRemoveFromLibrary={(libraryId) => {
                              void handleRemovePodcastFromLibrary(podcastId, libraryId);
                            }}
                            emptyMessage="No non-default libraries available."
                          />
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={styles.subscribeButton}
                            disabled={isSubscribing}
                            onClick={() => void handleSubscribe(result)}
                          >
                            {isSubscribing ? "Subscribing..." : "Subscribe"}
                          </button>
                          <LibraryTargetPicker
                            label="Add to library"
                            libraries={availableLibraries}
                            loading={availableLibrariesLoading}
                            disabled={isSubscribing}
                            onOpen={() => {
                              void loadAvailableLibraries();
                            }}
                            onSelectLibrary={(libraryId) => {
                              void handleSubscribe(result, libraryId);
                            }}
                            emptyMessage="No non-default libraries available."
                          />
                        </>
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
