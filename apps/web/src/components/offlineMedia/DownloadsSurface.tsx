"use client";

import { useEffect, useState } from "react";
import DownloadsOverlay from "./DownloadsOverlay";
import { subscribeDownloadsOpenRequest } from "./downloadsSurfaceIngress";
import { useOfflineMediaCapability } from "@/lib/offlineMedia/OfflineMediaProvider";
import { useOfflineReadingCapability } from "@/lib/offlineReading/OfflineReadingProvider";

/**
 * The single Downloads surface. It is mounted above both offline capabilities
 * and renders whenever *either* one is Ready: a device whose audio bridge was
 * rejected still has reading downloads to list, cancel, retry and remove, and
 * vice versa.
 */
export default function DownloadsSurface() {
  const audio = useOfflineMediaCapability();
  const reading = useOfflineReadingCapability();
  const [open, setOpen] = useState(false);

  useEffect(() => subscribeDownloadsOpenRequest(() => setOpen(true)), []);

  const available = audio.kind === "Ready" || reading.kind === "Ready";
  useEffect(() => {
    if (!available) setOpen(false);
  }, [available]);

  if (!available) return null;
  return (
    <DownloadsOverlay
      open={open}
      onClose={() => setOpen(false)}
      audio={audio.kind === "Ready" ? audio : null}
      reading={reading}
    />
  );
}
