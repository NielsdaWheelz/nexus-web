"use client";

import Image, { type ImageProps } from "next/image";
import {
  useEffect,
  useRef,
  type CSSProperties,
  type ImgHTMLAttributes,
} from "react";
import {
  useArtworkReader,
  useArtworkVisibility,
} from "@/lib/media/ArtworkProvider";
import { observeArtwork } from "@/lib/media/observeArtwork";
import {
  buildMediaImageProxySrc,
  type MediaImageProxySrc,
} from "@/lib/media/imageProxy";
import type { OraclePlateImageSrc } from "@/lib/media/oraclePlateImage";
import styles from "./MediaImage.module.css";

type ArtworkImageProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "srcSet" | "width" | "height"
> & {
  width: number;
  height: number;
  alt: string;
};

type MediaImageProps =
  | ({ kind: "owned"; src: OraclePlateImageSrc } & Omit<
      ImageProps,
      "src" | "unoptimized"
    >)
  | ({ kind: "proxied"; remoteUrl: string } & ArtworkImageProps)
  | ({ kind: "proxy-src"; src: MediaImageProxySrc } & ArtworkImageProps);

export default function MediaImage(props: MediaImageProps) {
  if (props.kind === "owned") {
    const { kind: _kind, src, alt, ...rest } = props;
    return <Image src={src} alt={alt} {...rest} />;
  }
  if (props.kind === "proxy-src") {
    const { kind: _kind, src, alt, ...rest } = props;
    return <ArtworkImage key={src} source={src} alt={alt} {...rest} />;
  }
  const { kind: _kind, remoteUrl, alt, ...rest } = props;
  return (
    <ArtworkImage
      key={remoteUrl}
      source={buildMediaImageProxySrc(remoteUrl)}
      alt={alt}
      {...rest}
    />
  );
}

function ArtworkImage({
  source,
  alt,
  ...props
}: ArtworkImageProps & { source: MediaImageProxySrc }) {
  const reader = useArtworkReader();
  const pageVisible = useArtworkVisibility();
  const element = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const image = element.current;
    if (image === null || !pageVisible) return;
    return observeArtwork(image, source, reader);
  }, [pageVisible, source, reader]);

  // Only the owned derivative reaches an image element. An absent src performs
  // no source request while its display demand waits for admission.
  const sizing: CSSProperties & {
    "--artwork-width": string;
    "--artwork-height": string;
  } = {
    ...props.style,
    "--artwork-width": `${props.width}px`,
    "--artwork-height": `${props.height}px`,
  };
  return (
    // eslint-disable-next-line @next/next/no-img-element -- the artwork owner already produces the bounded local display representation
    <img
      {...props}
      ref={element}
      className={[styles.artwork, props.className].filter(Boolean).join(" ")}
      style={sizing}
      alt={alt}
    />
  );
}
