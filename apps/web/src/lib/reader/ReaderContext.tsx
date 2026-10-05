"use client";

// The reader profile: one user's seven typography preferences. Changes apply at
// once and reach the server as one debounced PATCH (300ms), one request in
// flight, latest wins; a failed save keeps the change and offers Retry.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useFeedback } from "@/components/feedback/Feedback";
import { apiFetch, isApiError } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

export type ReaderProfile = Schema<"ReaderProfileOut">;

export interface ReaderProfileCapability {
  readonly profile: ReaderProfile;
  readonly persistence:
    | { readonly state: "Clean" | "Pending" }
    | { readonly state: "SaveFailed"; readonly failure: unknown };
  setTheme(value: ReaderProfile["theme"]): void;
  setFontFamily(value: ReaderProfile["font_family"]): void;
  setFocusMode(value: ReaderProfile["focus_mode"]): void;
  setHyphenation(value: ReaderProfile["hyphenation"]): void;
  setFontSize(value: number): void;
  setLineHeight(value: number): void;
  setColumnWidth(value: number): void;
  retrySave(): void;
}

const ReaderContext = createContext<ReaderProfileCapability | null>(null);
const SAVE_DELAY_MS = 300;
const FEEDBACK_KEY = "reader-profile-save";

export function ReaderProvider({
  initialProfile,
  children,
}: {
  readonly initialProfile: ReaderProfile;
  readonly children: ReactNode;
}) {
  const [profile, setProfile] = useState(initialProfile);
  const [persistence, setPersistence] = useState<
    ReaderProfileCapability["persistence"]
  >({ state: "Clean" });
  const unsent = useRef<Partial<ReaderProfile>>({});
  const timer = useRef<number | undefined>(undefined);
  const sending = useRef(false);
  const { publish, resolve } = useFeedback();

  const send = useCallback(async () => {
    window.clearTimeout(timer.current);
    const patch = unsent.current;
    if (sending.current || Object.keys(patch).length === 0) return;
    unsent.current = {};
    sending.current = true;
    try {
      const saved = await apiFetch<ApiJson<"/me/reader-profile", "patch">>(
        "/api/me/reader-profile",
        { method: "PATCH", body: JSON.stringify(patch), keepalive: true },
      );
      // Fields changed while this request flew stay as the user set them.
      setProfile({ ...saved.data, ...unsent.current });
      sending.current = false;
      if (Object.keys(unsent.current).length > 0) void send();
      else setPersistence({ state: "Clean" });
    } catch (failure) {
      sending.current = false;
      unsent.current = { ...patch, ...unsent.current };
      if (!handleUnauthenticatedApiError(failure)) {
        setPersistence({ state: "SaveFailed", failure });
      }
    }
  }, []);

  const intend = useCallback(
    (patch: Partial<ReaderProfile>) => {
      setProfile((current) => ({ ...current, ...patch }));
      unsent.current = { ...unsent.current, ...patch };
      setPersistence({ state: "Pending" });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void send(), SAVE_DELAY_MS);
    },
    [send],
  );

  useEffect(() => {
    const flush = () => void send();
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [send]);

  useEffect(() => {
    if (persistence.state !== "SaveFailed") {
      resolve(FEEDBACK_KEY);
      return;
    }
    const { failure } = persistence;
    publish({
      kind: "Persistent",
      key: FEEDBACK_KEY,
      announcement: "Assertive",
      content: {
        tone: "Danger",
        title: "Reader settings didn’t save",
        message: isApiError(failure)
          ? "The server had a problem. Retry to save your reader settings."
          : "A network problem interrupted the save. Check your connection and retry.",
        ...(isApiError(failure) && failure.requestId
          ? { requestId: failure.requestId }
          : {}),
      },
      actions: [{ label: "Retry", onClick: () => void send() }],
    });
  }, [persistence, publish, resolve, send]);

  const value = useMemo<ReaderProfileCapability>(
    () => ({
      profile,
      persistence,
      setTheme: (theme) => intend({ theme }),
      setFontFamily: (font_family) => intend({ font_family }),
      setFocusMode: (focus_mode) => intend({ focus_mode }),
      setHyphenation: (hyphenation) => intend({ hyphenation }),
      setFontSize: (font_size_px) => intend({ font_size_px }),
      setLineHeight: (line_height) => intend({ line_height }),
      setColumnWidth: (column_width_ch) => intend({ column_width_ch }),
      retrySave: () => void send(),
    }),
    [intend, persistence, profile, send],
  );
  return (
    <ReaderContext.Provider value={value}>{children}</ReaderContext.Provider>
  );
}

export function useReaderContext(): ReaderProfileCapability {
  const context = useContext(ReaderContext);
  // The profile is a required bootstrap seed; absence is a wiring defect.
  if (!context) throw new Error("useReaderContext requires a ReaderProvider");
  return context;
}
