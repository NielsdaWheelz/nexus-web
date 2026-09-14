"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import { isApiError } from "@/lib/api/client";
import {
  reportClientDefect,
  withClientDefectContext,
} from "@/lib/telemetry/clientDefects";
import { ArtworkReader } from "./artwork";

const ArtworkContext = createContext<ArtworkReader | null>(null);
const ArtworkVisibility = createContext(false);

/** The account shell owns this reader; leaves own and release its display demand. */
export function ArtworkProvider({
  limits,
  children,
}: {
  limits: { readonly maxDimension: number; readonly residentPixels: number };
  children: ReactNode;
}) {
  const [reader] = useState(() => new ArtworkReader(limits));
  const [visible, setVisible] = useState(false);
  useEffect(
    () =>
      reader.subscribeFailures((failure) => {
        if (!failure) return;
        // Rejected external artwork remains an explicit image failure. Exhausted
        // reads and owned decoder defects retain their structural telemetry.
        if (
          isApiError(failure.error) &&
          [400, 403, 404, 413, 422].includes(failure.error.status)
        )
          return;
        reportClientDefect(
          withClientDefectContext(failure.error, { phase: "Read" }),
          {
            scope: "Artwork",
            componentStack: "",
          },
        );
      }),
    [reader],
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return (
    <ArtworkContext value={reader}>
      <ArtworkVisibility value={visible}>{children}</ArtworkVisibility>
    </ArtworkContext>
  );
}

export function useArtworkVisibility(): boolean {
  return useContext(ArtworkVisibility);
}

export function useArtworkReader(): ArtworkReader {
  const reader = useContext(ArtworkContext);
  if (!reader) throw new Error("Artwork requires its account-scoped provider");
  return reader;
}

export function ArtworkFailureNotice() {
  const reader = useArtworkReader();
  const failures = useSyncExternalStore(
    reader.subscribeFailures,
    reader.failedDemands,
    () => 0,
  );
  if (failures === 0) return null;
  return (
    <FeedbackNotice
      content={{ tone: "Danger", title: "Some artwork couldn’t load." }}
      announcement="Polite"
      actions={[{ label: "Retry artwork", onClick: reader.retryFailures }]}
    />
  );
}
