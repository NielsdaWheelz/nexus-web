"use client";

import type { CSSProperties } from "react";
import type { ResourceThumbSpec } from "@/lib/collections/types";
import MediaImage from "@/components/ui/MediaImage";
import { cx } from "@/lib/ui/cx";
import styles from "./ResourceThumb.module.css";

const SIZE_PX = { sm: 32, md: 44, lg: 64 } as const;
type ResourceThumbSize = keyof typeof SIZE_PX | "fill";

export default function ResourceThumb({
  spec,
  alt,
  size = "md",
  className,
  viewTransitionName,
}: {
  spec: ResourceThumbSpec;
  alt: string;
  size?: ResourceThumbSize;
  className?: string;
  viewTransitionName?: string;
}) {
  const fill = size === "fill";
  const px = fill ? 320 : SIZE_PX[size];
  const transitionStyle: CSSProperties = viewTransitionName
    ? { viewTransitionName }
    : {};

  if (spec.remoteUrl) {
    return (
      <MediaImage
        kind="proxied"
        remoteUrl={spec.remoteUrl}
        alt={alt}
        width={px}
        height={px}
        className={cx(styles.cover, fill && styles.fill, className)}
        data-view-transition-part="thumb"
        style={viewTransitionName ? transitionStyle : undefined}
      />
    );
  }

  const Icon = spec.icon;
  return (
    <span
      className={cx(styles.iconTile, fill && styles.fill, className)}
      style={{
        ...(fill ? {} : { width: px, height: px }),
        ...transitionStyle,
      }}
      data-view-transition-part="thumb"
      role="img"
      aria-label={alt}
    >
      <Icon size={Math.round(px * 0.5)} aria-hidden="true" />
    </span>
  );
}
