"use client";

import { useEffect, useRef } from "react";
import EntryFailure from "@/components/EntryFailure";

export default function ErrorBoundary({ error }: { error: Error & { digest?: string } }) {
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    console.error("Nexus entry failed:", error);
    if (document.activeElement === null || document.activeElement === document.body) {
      surface.current?.focus({ preventScroll: true });
    }
  }, [error]);
  return (
    <div ref={surface} role="alert" tabIndex={-1}>
      <EntryFailure
        title="something went wrong"
        description="nexus needs a fix before this can continue."
      >
        {null}
      </EntryFailure>
    </div>
  );
}
