"use client";

import type { ConnectionEndpointOut } from "@/lib/resourceGraph/connections";
import { resourceIconForScheme } from "@/lib/resources/resourceKind";
import { cx } from "@/lib/ui/cx";
import styles from "./ConnectionRail.module.css";

/**
 * In-row reveal of deterministic peers: provenance connections plus optional
 * similarity/shared-author related items. Deleted or forbidden peers render as
 * inert "Unavailable" chips, never as a leaked link.
 */
export default function ConnectionRail({
  peers,
  related,
  relatedStatus = "idle",
}: {
  peers: ConnectionEndpointOut[];
  related?: ConnectionEndpointOut[];
  relatedStatus?: "idle" | "loading" | "error" | "ready";
}) {
  return (
    <div className={styles.rail}>
      <PeerGroup label="Connected" peers={peers} />
      <RelatedGroup peers={related ?? []} status={relatedStatus} />
    </div>
  );
}

function RelatedGroup({
  peers,
  status,
}: {
  peers: ConnectionEndpointOut[];
  status: "idle" | "loading" | "error" | "ready";
}) {
  if (status === "idle") return null;
  if (status === "loading") {
    return <StatusGroup label="Related" text="Loading related items..." />;
  }
  if (status === "error") {
    return <StatusGroup label="Related" text="Could not load related items." />;
  }
  if (peers.length === 0) {
    return <StatusGroup label="Related" text="No related items yet." />;
  }
  return <PeerGroup label="Related" peers={peers} />;
}

function StatusGroup({ label, text }: { label: string; text: string }) {
  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>{label}</span>
      <p className={styles.empty}>{text}</p>
    </div>
  );
}

function PeerGroup({ label, peers }: { label: string; peers: ConnectionEndpointOut[] }) {
  if (peers.length === 0) return null;
  return (
    <div className={styles.group}>
      <span className={styles.groupLabel}>{label}</span>
      <ul className={styles.peers}>
        {peers.map((peer) => {
          const Icon = resourceIconForScheme(peer.scheme);
          const text = peer.label ?? (peer.missing ? "Unavailable" : "Untitled");
          return (
            <li key={peer.ref}>
              {peer.href && !peer.missing ? (
                <a className={styles.peer} href={peer.href}>
                  <Icon size={13} aria-hidden="true" />
                  <span>{text}</span>
                </a>
              ) : (
                <span className={cx(styles.peer, peer.missing && styles.missing)}>
                  <Icon size={13} aria-hidden="true" />
                  <span>{text}</span>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
