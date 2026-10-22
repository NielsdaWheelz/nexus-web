"use client";

import { useState } from "react";
import MediaImage from "@/components/ui/MediaImage";
import styles from "./PodcastRowArtwork.module.css";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * passive list artwork, keyed by source by its caller. both layers retain their
 * geometry and child structure when loading finishes. the root marks its direct
 * image as fixed artwork for sortable load guards.
 */
export default function PodcastRowArtwork({
  title,
  imageUrl,
}: {
  readonly title: string;
  readonly imageUrl: string | null;
}) {
  const [ready, setReady] = useState(false);
  const initials = title
    .trim()
    .split(/\s+/u)
    .slice(0, 2)
    .map((word) =>
      graphemes.segment(word.toUpperCase()).containing(0)?.segment,
    )
    .join("") || "P";

  return (
    <span
      className={styles.root}
      data-row-fixed-artwork=""
      data-ready={ready || undefined}
    >
      <span className={styles.initials} aria-hidden="true">{initials}</span>
      {imageUrl !== null ? (
        <MediaImage
          kind="proxied"
          remoteUrl={imageUrl}
          alt=""
          width={44}
          height={44}
          loading="lazy"
          decoding="async"
          draggable={false}
          className={styles.image}
          onLoad={(event) => setReady(event.currentTarget.naturalWidth > 0)}
        />
      ) : null}
    </span>
  );
}
