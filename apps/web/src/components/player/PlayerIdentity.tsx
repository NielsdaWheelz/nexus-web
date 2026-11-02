"use client";

import { useId, type Ref } from "react";
import * as Icon from "lucide-react";
import Button from "@/components/ui/Button";
import ButtonLink from "@/components/ui/ButtonLink";
import MediaImage from "@/components/ui/MediaImage";
import type { PlayerState } from "@/lib/player/playerRuntime";
import { cx } from "@/lib/ui/cx";
import type { TargetActivationEvent } from "@/lib/ui/targetActivation";
import styles from "./PlayerIdentity.module.css";

const ARTWORK_PX = 44;

/** Artwork, title and subtitle as one control: the episode's link in the bar and sheet, the sheet's opener in the mini. */
export default function PlayerIdentity(props: {
  readonly loaded: Extract<PlayerState, { kind: "Loaded" }>;
  readonly label: string;
  readonly status: string | null;
  readonly onOpen: (event: TargetActivationEvent) => void;
} & (
  | { readonly variant: "Bar" | "Sheet"; readonly href: string }
  | { readonly variant: "Mini"; readonly buttonRef: Ref<HTMLButtonElement> }
)) {
  const { loaded, label, status, onOpen } = props;
  const statusId = useId();
  const { descriptor } = loaded.source;
  const subtitle = descriptor.subtitle;
  const contents = <span className={styles.identityContent}>
      <span className={styles.artworkBox}>{descriptor.artwork_url !== null
        ? <MediaImage kind="proxied" remoteUrl={descriptor.artwork_url} alt="" width={ARTWORK_PX} height={ARTWORK_PX} className={styles.artwork} />
        : <span className={styles.placeholder} style={{ width: ARTWORK_PX, height: ARTWORK_PX }} aria-hidden="true">{descriptor.title.trim().charAt(0).toLocaleUpperCase() || "N"}</span>}
        {status ? <span className={styles.identityStatus} aria-hidden="true"><Icon.Info size={12} /></span> : null}</span>
      <span className={styles.identityCopy}>
        <span className={styles.title}>{descriptor.title}</span>
        {subtitle ? <span className={styles.subtitle}>{subtitle}</span> : null}
      </span>
      {status ? <span id={statusId} className={styles.srOnly}>{status}</span> : null}
    </span>;
  const className = cx(styles.identity, props.variant === "Mini" && styles.mini, props.variant === "Sheet" && styles.sheet);
  const name = `${label}${subtitle ? `, ${subtitle}` : ""}`;
  return props.variant === "Mini"
    ? <Button ref={props.buttonRef} className={className} onClick={onOpen} aria-label={name} aria-describedby={status ? statusId : undefined}>{contents}</Button>
    : <ButtonLink href={props.href} className={className} data-workspace-rich-target="true" onClick={onOpen} onKeyDown={onOpen} aria-label={name} aria-describedby={status ? statusId : undefined}>{contents}</ButtonLink>;
}
