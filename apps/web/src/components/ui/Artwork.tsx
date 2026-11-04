"use client";

import { useState, type ReactNode, type SyntheticEvent } from "react";
import MediaImage from "@/components/ui/MediaImage";
import { assertNever } from "@/lib/assertNever";
import type { MediaImageProxySrc } from "@/lib/media/imageProxy";
import { cx } from "@/lib/ui/cx";
import styles from "./Artwork.module.css";

/** No picture; a publisher's url, fetched through the image proxy; a url already through the
 * proxy; or a blob saved on this device. */
export type ArtworkSource =
  | { readonly kind: "Absent" }
  | { readonly kind: "Remote"; readonly url: string }
  | { readonly kind: "Proxied"; readonly url: MediaImageProxySrc }
  | { readonly kind: "Local"; readonly url: string };

/** A publisher's image url, which a show may lack. */
export function remoteArtwork(url: string | null): ArtworkSource {
  return url === null ? { kind: "Absent" } : { kind: "Remote", url };
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Passive artwork: initials beneath, the image above once it loads with a nonzero width. Absent, loading and failed keep one geometry; a new source starts over. Decorative: the adjacent title names the subject. */
export default function Artwork({ title, source, size, className }: {
  readonly title: string;
  readonly source: ArtworkSource;
  readonly size: number;
  readonly className?: string;
}) {
  // The first grapheme of each of the first two words, so a joined emoji, a flag or a combining
  // mark stays whole. An empty title paints an empty tile.
  const initials = title.trim().split(/\s+/u).slice(0, 2)
    .map(word => graphemes.segment(word.toUpperCase()).containing(0)?.segment ?? "").join("");
  // Initials scale with the box, not the text: 9/22 gives the 44px tile its 18px. The root marks
  // its direct image as fixed artwork, so a load never invalidates a sortable drag.
  return <span className={cx(styles.root, className)} style={{ width: size, height: size, fontSize: size * 9 / 22 }}
    aria-hidden="true" data-fixed-artwork="">
    <Layers key={source.kind === "Absent" ? "" : source.url} initials={initials} source={source} size={size} />
  </span>;
}

/** Keyed by source, so a new source mounts unloaded and an old image's late load cannot land. */
function Layers({ initials, source, size }: { readonly initials: string; readonly source: ArtworkSource; readonly size: number }) {
  const [loaded, setLoaded] = useState(false);
  const image = {
    alt: "", width: size, height: size, decoding: "async", draggable: false, className: cx(styles.image, loaded && styles.loaded),
    onLoad: (event: SyntheticEvent<HTMLImageElement>) => setLoaded(event.currentTarget.naturalWidth > 0),
  } as const;
  let picture: ReactNode;
  switch (source.kind) {
    case "Absent": picture = null; break;
    case "Remote": picture = <MediaImage kind="proxied" remoteUrl={source.url} {...image} />; break;
    case "Proxied": picture = <MediaImage kind="proxy-src" src={source.url} {...image} />; break;
    case "Local": picture = <MediaImage kind="static" src={source.url} {...image} />; break;
    default: assertNever(source);
  }
  return <>
    <span className={cx(styles.initials, loaded && styles.loaded)}>{initials}</span>
    {picture}
  </>;
}
