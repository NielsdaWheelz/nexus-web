"use client";

import { useState } from "react";
import MediaCatalogPage from "@/components/MediaCatalogPage";
import { apiFetch, isApiError } from "@/lib/api/client";
import SectionCard from "@/components/ui/SectionCard";
import StateMessage from "@/components/ui/StateMessage";
import { AppList, AppListItem } from "@/components/ui/AppList";
import styles from "./page.module.css";

interface PodcastDiscoveryItem {
  provider_podcast_id: string;
  title: string;
  author: string | null;
  feed_url: string;
  website_url: string | null;
  image_url: string | null;
  description: string | null;
}

export default function PodcastsPage() {
  const [query, setQuery] = useState("");
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [discoverResults, setDiscoverResults] = useState<PodcastDiscoveryItem[]>([]);
  const [hasSearched, setHasSearched] = useState(false);

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

  return (
    <MediaCatalogPage
      title="Podcasts"
      description="Discover podcasts globally and review podcast episodes already in your libraries."
      allowedKinds={["podcast_episode"]}
      emptyMessage="No podcast episodes found in your visible libraries."
      headerSlot={
        <SectionCard
          title="Discover podcasts"
          description="Search global feeds. subscription controls are intentionally deferred in this MVP."
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
              {discoverResults.map((result) => (
                <AppListItem
                  key={result.provider_podcast_id}
                  href={result.website_url || result.feed_url}
                  target="_blank"
                  rel="noreferrer"
                  icon={<span className={styles.thumbnailFallback}>POD</span>}
                  title={result.title}
                  description={result.author || "Unknown author"}
                  meta={result.feed_url}
                  trailing={<span className={styles.externalLink}>Open source</span>}
                />
              ))}
            </AppList>
          )}
        </SectionCard>
      }
    />
  );
}
