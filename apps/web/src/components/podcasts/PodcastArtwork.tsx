"use client";

import { useState, type SyntheticEvent } from "react";
import MediaImage from "@/components/ui/MediaImage";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import styles from "./PodcastArtwork.module.css";

export type PodcastArtworkSource =
  | { readonly kind: "Absent" }
  | { readonly kind: "Remote"; readonly url: string }
  | { readonly kind: "Proxied"; readonly url: MediaImageProxySrc };

/** Overview artwork keeps its geometry on failure; another source can recover. */
export default function PodcastArtwork({ title, image, size, className }: {
  readonly title: string;
  readonly image: PodcastArtworkSource;
  readonly size: number;
  readonly className: string;
}) {
  const source = image.kind === "Absent" ? null : image.url;
  const [failed, setFailed] = useState<string | null>(null);
  const initials = title.trim().split(/\s+/u).slice(0, 2)
    .map(word => [...word.toUpperCase()][0]).join("") || "P";
  const props = {
    alt: "", width: size, height: size, className: styles.image,
    onError: () => setFailed(source),
    onLoad: (event: SyntheticEvent<HTMLImageElement>) => {
      if (event.currentTarget.naturalWidth <= 0) setFailed(source);
    },
  };
  return <span className={`${styles.root} ${className}`} aria-hidden="true">
    {source === null || source === failed ? initials : image.kind === "Remote" ? (
      <MediaImage key={source} kind="proxied" remoteUrl={image.url} {...props} />
    ) : image.kind === "Proxied" ? (
      <MediaImage key={source} kind="proxy-src" src={image.url} {...props} />
    ) : null}
  </span>;
}
