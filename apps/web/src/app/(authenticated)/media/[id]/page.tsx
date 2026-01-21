"use client";

import { useEffect, useState, use } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch, isApiError } from "@/lib/api/client";
import Pane from "@/components/Pane";
import PaneContainer from "@/components/PaneContainer";
import HtmlRenderer from "@/components/HtmlRenderer";
import styles from "./page.module.css";

interface Media {
  id: string;
  kind: string;
  title: string;
  canonical_source_url: string | null;
  processing_status: string;
  created_at: string;
  updated_at: string;
}

interface Fragment {
  id: string;
  media_id: string;
  idx: number;
  html_sanitized: string;
  canonical_text: string;
  created_at: string;
}

export default function MediaViewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [media, setMedia] = useState<Media | null>(null);
  const [fragments, setFragments] = useState<Fragment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [mediaData, fragmentsData] = await Promise.all([
          apiFetch<Media>(`/api/media/${id}`),
          apiFetch<Fragment[]>(`/api/media/${id}/fragments`),
        ]);
        setMedia(mediaData);
        setFragments(fragmentsData);
        setError(null);
      } catch (err) {
        if (isApiError(err)) {
          if (err.status === 404) {
            setError("Media not found or you don't have access to it.");
          } else {
            setError(err.message);
          }
        } else {
          setError("Failed to load media");
        }
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [id]);

  if (loading) {
    return (
      <PaneContainer>
        <Pane title="Loading...">
          <div className={styles.loading}>Loading media...</div>
        </Pane>
      </PaneContainer>
    );
  }

  if (error || !media) {
    return (
      <PaneContainer>
        <Pane title="Error">
          <div className={styles.errorContainer}>
            <div className={styles.error}>{error || "Media not found"}</div>
            <Link href="/libraries" className={styles.backLink}>
              ← Back to Libraries
            </Link>
          </div>
        </Pane>
      </PaneContainer>
    );
  }

  const canRead =
    media.processing_status === "ready" ||
    media.processing_status === "ready_for_reading";

  return (
    <PaneContainer>
      <Pane title={media.title}>
        <div className={styles.content}>
          <div className={styles.header}>
            <Link href="/libraries" className={styles.backLink}>
              ← Back to Libraries
            </Link>

            <div className={styles.metadata}>
              <span className={styles.kind}>{media.kind}</span>
              {media.canonical_source_url && (
                <a
                  href={media.canonical_source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.sourceLink}
                >
                  View Source ↗
                </a>
              )}
            </div>
          </div>

          {!canRead ? (
            <div className={styles.notReady}>
              <p>This media is still being processed.</p>
              <p>Status: {media.processing_status}</p>
            </div>
          ) : fragments.length === 0 ? (
            <div className={styles.empty}>
              <p>No content available for this media.</p>
            </div>
          ) : (
            <div className={styles.fragments}>
              {fragments.map((fragment) => (
                <HtmlRenderer
                  key={fragment.id}
                  htmlSanitized={fragment.html_sanitized}
                  className={styles.fragment}
                />
              ))}
            </div>
          )}
        </div>
      </Pane>
    </PaneContainer>
  );
}
