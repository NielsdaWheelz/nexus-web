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
import { remoteReady } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { useSettingsRefresh } from "@/lib/native/settingsRefresh";
import { FeedbackFailure, useFeedback, useFeedbackOccurrence } from "@/components/feedback/Feedback";
import { apiFetch, apiTransportFeedback, outcomeUnknown, isApiError, isSameSystemApiDefect } from "@/lib/api/client";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

export type ReaderProfile = Schema<"ReaderProfileOut">;

export interface ReaderProfileCapability {
  readonly profile: ReaderProfile;
  readonly persistence:
    | { readonly state: "Clean" | "Pending" }
    | { readonly state: "SaveFailed"; readonly failure: unknown };
  readonly editable: boolean;
  readonly saving: boolean;
  readonly failureOccurrence: object;
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

export function ReaderProvider({
  initialProfile,
  children,
}: {
  readonly initialProfile: ReaderProfile;
  readonly children: ReactNode;
}) {
  const refreshSettings = useSettingsRefresh();
  const feedback = useFeedback();
  const editable = useRemoteAdmission() === "Ready";
  const [profile, setProfile] = useState(initialProfile);
  const [persistence, setPersistence] = useState<
    ReaderProfileCapability["persistence"]
  >({ state: "Clean" });
  const occurrence = useFeedbackOccurrence(persistence.state === "SaveFailed");
  const [saving, setSaving] = useState(false);
  const unsent = useRef<Partial<ReaderProfile>>({});
  const timer = useRef<number | undefined>(undefined);
  const sending = useRef(false);
  const live = useRef(true);
  const [defect, setDefect] = useState<{ error: unknown } | null>(null);

  useEffect(() => {
    if (!sending.current) setProfile(Object.keys(unsent.current).length === 0 ? initialProfile : { ...initialProfile, ...unsent.current });
  }, [initialProfile]);

  const send = useCallback(async () => {
    window.clearTimeout(timer.current);
    const patch = unsent.current;
    if (!live.current || sending.current || Object.keys(patch).length === 0) return;
    unsent.current = {};
    sending.current = true;
    setSaving(true);
    try {
      const saved = await apiFetch<ApiJson<"/me/reader-profile", "patch">>(
        "/api/me/reader-profile",
        { method: "PATCH", body: JSON.stringify(patch), keepalive: true },
      );
      if (!live.current) return;
      void refreshSettings();
      // Fields changed while this request flew stay as the user set them.
      setProfile({ ...saved.data, ...unsent.current });
      sending.current = false;
      setSaving(false);
      if (Object.keys(unsent.current).length > 0) void send();
      else setPersistence({ state: "Clean" });
    } catch (failure) {
      sending.current = false;
      setSaving(false);
      if (!live.current) return;
      unsent.current = { ...patch, ...unsent.current };
      handleUnauthenticatedApiError(failure);
      if (!isApiError(failure) || isSameSystemApiDefect(failure)) return setDefect({ error: failure });
      // The retained owner projects the same failure through current hosts.
      setPersistence({ state: "SaveFailed", failure });
    }
  }, [refreshSettings]);

  const intend = useCallback(
    (patch: Partial<ReaderProfile>) => {
      if (!remoteReady()) {
        feedback.receipt({ tone: "Neutral", title: "changing reader settings requires a connection" });
        return;
      }
      setProfile((current) => ({ ...current, ...patch }));
      unsent.current = { ...unsent.current, ...patch };
      setPersistence((current) => current.state === "SaveFailed" ? current : { state: "Pending" });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void send(), SAVE_DELAY_MS);
    },
    [feedback, send],
  );

  useEffect(() => {
    live.current = true;
    const flush = () => void send();
    window.addEventListener("pagehide", flush);
    return () => {
      live.current = false;
      window.clearTimeout(timer.current);
      window.removeEventListener("pagehide", flush);
    };
  }, [send]);

  const value = useMemo<ReaderProfileCapability>(
    () => ({
      profile,
      persistence,
      editable,
      saving,
      failureOccurrence: occurrence,
      setTheme: (theme) => intend({ theme }),
      setFontFamily: (font_family) => intend({ font_family }),
      setFocusMode: (focus_mode) => intend({ focus_mode }),
      setHyphenation: (hyphenation) => intend({ hyphenation }),
      setFontSize: (font_size_px) => intend({ font_size_px }),
      setLineHeight: (line_height) => intend({ line_height }),
      setColumnWidth: (column_width_ch) => intend({ column_width_ch }),
      retrySave: () => void send(),
    }),
    [editable, intend, persistence, profile, send, saving, occurrence],
  );
  if (defect) throw defect.error;
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

/** The profile owner retains this recovery when typography controls leave their pane. */
export function ReaderSettingsFailure() {
  const reader = useReaderContext();
  if (reader.persistence.state !== "SaveFailed") return null;
  const failure = reader.persistence.failure;
  const content = (isApiError(failure) && apiTransportFeedback(failure, "couldn’t save reader settings")) || {
    tone: "Warning" as const, title: "couldn’t save reader settings", message: "your settings are applied in this tab. retry to sync them.",
    requestId: isApiError(failure) ? failure.requestId : undefined};
  return <FeedbackFailure scope="Local" occurrence={reader.failureOccurrence}
    content={outcomeUnknown(failure) && failure.code !== "E_UNAUTHENTICATED"
      ? {...content, title: "change not confirmed", message: "the request may have succeeded."} : content}
    announcement="Polite" actions={[{label: "retry", onClick: reader.retrySave, busy: reader.saving}]} />;
}
