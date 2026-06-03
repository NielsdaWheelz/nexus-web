"use client";

import Image, { type ImageProps } from "next/image";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";

type SharedImageProps = Omit<ImageProps, "src" | "unoptimized">;

type MediaImageProps =
  | ({ kind: "owned"; src: string } & SharedImageProps)
  | ({ kind: "proxied"; remoteUrl: string } & SharedImageProps);

export default function MediaImage(props: MediaImageProps) {
  if (props.kind === "owned") {
    const { kind: _kind, src, alt, ...rest } = props;
    return <Image src={src} alt={alt} {...rest} />;
  }
  const { kind: _kind, remoteUrl, alt, ...rest } = props;
  return (
    <Image src={buildMediaImageProxySrc(remoteUrl)} alt={alt} unoptimized {...rest} />
  );
}
