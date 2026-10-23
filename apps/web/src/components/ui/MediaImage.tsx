"use client";

import { useHostPolicy, type HostImageProps } from "@/lib/host/policy";
import {
  buildMediaImageProxySrc,
  type MediaImageProxySrc,
} from "@/lib/media/imageProxy";

type SharedImageProps = Omit<HostImageProps, "src" | "unoptimized">;

type MediaImageProps =
  | ({ kind: "static"; src: string } & SharedImageProps)
  | ({ kind: "proxied"; remoteUrl: string } & SharedImageProps)
  | ({ kind: "proxy-src"; src: MediaImageProxySrc } & SharedImageProps);

export default function MediaImage(props: MediaImageProps) {
  const { Image } = useHostPolicy();
  if (props.kind === "static") {
    const { kind: _kind, src, alt, ...rest } = props;
    return <Image src={src} alt={alt} {...rest} />;
  }
  if (props.kind === "proxy-src") {
    const { kind: _kind, src, alt, ...rest } = props;
    return <Image src={src} alt={alt} unoptimized {...rest} />;
  }
  const { kind: _kind, remoteUrl, alt, ...rest } = props;
  return (
    <Image
      src={buildMediaImageProxySrc(remoteUrl)}
      alt={alt}
      unoptimized
      {...rest}
    />
  );
}
