"use client";

import { useEffect, useState } from "react";

function resolveBrowserTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) return "UTC";
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

/** Hydration-safe owner for timezone-sensitive reads. ``null`` means the
 * browser has not resolved its IANA zone yet; callers must not issue a
 * timezone-sensitive request in that state. */
export function useHydratedBrowserTimeZone(): string | null {
  const [timeZone, setTimeZone] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => setTimeZone(resolveBrowserTimeZone());
    refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, []);

  return timeZone;
}
