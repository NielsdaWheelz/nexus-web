"use client";

import { useEffect, useRef, useState } from "react";

/** Only the short fact is live; controls and disclosure never enter the live region. */
export function Announcement({ text, level, deferred = false, occurrence, onPublish }: {
  text: string; level: "None" | "Polite" | "Assertive"; deferred?: boolean; occurrence?: object; onPublish?: () => void;
}) {
  // A new local occurrence keeps the live region empty for a rendered frame.
  const [spoken, setSpoken] = useState<{ text: string; occurrence?: object }>({ text: "" });
  const suppressed = useRef<{ text: string; occurrence?: object } | null>(null);
  const delivered = useRef<object | null>(null);
  const publish = useRef(onPublish);
  publish.current = onPublish;
  useEffect(() => {
    if (deferred) {
      suppressed.current = { text, occurrence };
      setSpoken({ text: "" });
      return;
    }
    if (suppressed.current?.text === text && suppressed.current.occurrence === occurrence) return;
    suppressed.current = null;
    if (level === "None") { setSpoken({ text: "", occurrence }); return; }
    if (occurrence !== undefined && delivered.current === occurrence) return;
    const next = { text, occurrence };
    if (occurrence === undefined) {
      setSpoken(next);
      return;
    }
    let publication: number | null = null;
    const empty = requestAnimationFrame(() => {
      publication = requestAnimationFrame(() => { delivered.current = occurrence ?? null; setSpoken(next); publish.current?.(); });
    });
    return () => {
      cancelAnimationFrame(empty);
      if (publication !== null) cancelAnimationFrame(publication);
    };
  }, [text, level, deferred, occurrence]);
  if (level === "None") return null;
  return <span
    className="sr-only"
    role={level === "Assertive" ? "alert" : "status"}
    aria-live={deferred ? "off" : level === "Assertive" ? "assertive" : "polite"}
    aria-atomic="true"
  >{occurrence !== undefined && spoken.occurrence !== occurrence ? "" : spoken.text}</span>;
}

