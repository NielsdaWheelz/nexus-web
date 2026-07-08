"use client";

import type { CSSProperties } from "react";
import type { ResourceThumbSpec } from "@/lib/collections/types";
import MediaImage from "@/components/ui/MediaImage";
import { cx } from "@/lib/ui/cx";
import styles from "./ResourceThumb.module.css";

const SIZE_PX = { sm: 32, md: 44, lg: 64 } as const;
type ResourceThumbSize = keyof typeof SIZE_PX | "fill";

const sizeClass: Record<keyof typeof SIZE_PX, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
};

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
  const sizingClass = fill ? styles.fill : sizeClass[size];
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
        className={cx(styles.cover, sizingClass, className)}
        data-view-transition-part="thumb"
        style={viewTransitionName ? transitionStyle : undefined}
      />
    );
  }

  const Icon = spec.icon;
  return (
    <span
      className={cx(styles.iconTile, sizingClass, className)}
      style={viewTransitionName ? transitionStyle : undefined}
      data-view-transition-part="thumb"
      role="img"
      aria-label={alt}
    >
      <Icon className={styles.icon} aria-hidden="true" />
    </span>
  );
}
