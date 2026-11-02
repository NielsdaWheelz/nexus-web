"use client";

// The reader profile: one user's seven typography preferences. Changes apply at
// once and reach the server as one debounced PATCH (300ms), one request in
// flight, latest wins; a failed save keeps the change and holds a slip until a save
// lands, with the verb its transport allows. Nothing resends it on reconnect.
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
import { ReaderProfileProvider } from "./ReaderProfileContext";
import { remoteReady } from "@/lib/native/admission";
import { useRemoteAdmission } from "@/lib/native/admissionHooks";
import { useSettingsRefresh } from "@/lib/native/settingsRefresh";
import { Hold, useOutcome } from "@/components/feedback/Feedback";
import type { Verb } from "@/components/feedback/stage";
import { apiFetch, isApiError, isSameSystemApiDefect, type ApiError } from "@/lib/api/client";
import { staleBuild } from "@/lib/api/failure";
import { heldSaveFailure, unadmitted } from "@/lib/media/admissions";
import type { ApiJson, Schema } from "@/lib/api/wire";
import { handleUnauthenticatedApiError } from "@/lib/auth/UnauthenticatedApiBoundary";

export type ReaderProfile = Schema<"ReaderProfileOut">;

export interface ReaderProfileCapability {
  readonly profile: ReaderProfile;
  readonly persistence:
    | { readonly state: "Clean" | "Pending" }
    /** `offline`: the device was offline when the save failed. */
    | { readonly state: "SaveFailed"; readonly failure: ApiError; readonly offline: boolean; readonly attempt: number };
  readonly editable: boolean;
  readonly saving: boolean;
  /** Kept for the settings pane's old mount until L7. */
  readonly connectionOccurrence: object | null;
  readonly unavailableReason: string | null;
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
  const { say } = useOutcome();
  const admission = useRemoteAdmission();
  const editable = admission === "Ready";
  const blocked = admission !== "Ready" && admission !== "Checking";
  const blockedOccurrence = useMemo(() => blocked ? {} : null, [blocked]);
  const connectionOccurrence = admission === "Unavailable" ? blockedOccurrence : null;
  const unavailableReason = admission === "Ready" ? null : admission === "Checking" ? "still checking the connection."
    : admission === "SignInRequired" ? "sign in to change reader settings."
    : admission === "UpdateRequired" ? staleBuild() : "reader settings need a connection.";
  const [profile, setProfile] = useState(initialProfile);
  const [persistence, setPersistence] = useState<
    ReaderProfileCapability["persistence"]
  >({ state: "Clean" });
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
      setPersistence((current) => ({ state: "SaveFailed", failure, offline: navigator.onLine === false, attempt: current.state === "SaveFailed" ? current.attempt + 1 : 0 }));
    }
  }, [refreshSettings]);

  const intend = useCallback(
    (patch: Partial<ReaderProfile>) => {
      if (!remoteReady()) {
        const { line, verbs } = unadmitted("couldn’t change reader settings.");
        say(line, verbs ?? undefined);
        return;
      }
      setProfile((current) => ({ ...current, ...patch }));
      unsent.current = { ...unsent.current, ...patch };
      setPersistence((current) => current.state === "SaveFailed" ? current : { state: "Pending" });
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void send(), SAVE_DELAY_MS);
    },
    [say, send],
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
      connectionOccurrence,
      unavailableReason,
      setTheme: (theme) => intend({ theme }),
      setFontFamily: (font_family) => intend({ font_family }),
      setFocusMode: (focus_mode) => intend({ focus_mode }),
      setHyphenation: (hyphenation) => intend({ hyphenation }),
      setFontSize: (font_size_px) => intend({ font_size_px }),
      setLineHeight: (line_height) => intend({ line_height }),
      setColumnWidth: (column_width_ch) => intend({ column_width_ch }),
      retrySave: () => void send(),
    }),
    [editable, intend, persistence, profile, send, saving, connectionOccurrence, unavailableReason],
  );
  if (defect) throw defect.error;
  const retry: Verb = { label: "retry", commandKey: "RetryReaderSettings", run: () => void send(), busy: saving };
  const failed = persistence.state === "SaveFailed"
    ? { attempt: persistence.attempt, ...heldSaveFailure(persistence.failure, persistence.offline, retry, SAVE_COPY) } : null;
  return (
    <ReaderContext.Provider value={value}><ReaderProfileProvider profile={profile}>
      {children}
      {failed ? <Hold id="reader-settings" attempt={failed.attempt} line={failed.line} verbs={failed.verbs ?? undefined} /> : null}
    </ReaderProfileProvider></ReaderContext.Provider>
  );
}

export function useReaderContext(): ReaderProfileCapability {
  const context = useContext(ReaderContext);
  // The profile is a required bootstrap seed; absence is a wiring defect.
  if (!context) throw new Error("useReaderContext requires a ReaderProvider");
  return context;
}

/** The change applies here whatever its save met. */
const SAVE_COPY = {
  fact: "couldn’t save reader settings.",
  unsure: { fact: "not sure reader settings saved.", reason: "they may have gone through." },
  kept: { fact: "couldn’t save reader settings.", reason: "they apply in this tab only." },
};

/** The provider's held slip is this failure's one home; the settings pane's mount says nothing
 * more. The export stands until L7 removes that mount. */
export function ReaderSettingsFailure() {
  return null;
}
