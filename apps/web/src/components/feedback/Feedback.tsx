"use client";

import {
  AlertCircle,
  CheckCircle2,
  Info,
  TriangleAlert,
  X,
} from "lucide-react";
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
import Button from "@/components/ui/Button";
import { isApiError, type ApiError } from "@/lib/api/client";
import styles from "./Feedback.module.css";

export type FeedbackSeverity = "neutral" | "info" | "success" | "warning" | "error";

export interface FeedbackContent {
  severity: FeedbackSeverity;
  title: string;
  message?: string;
  requestId?: string;
}

interface FeedbackAction {
  label: string;
  onClick: () => void;
}

interface ToastFeedback extends FeedbackContent {
  id: number;
  dedupeKey?: string;
  action?: FeedbackAction;
  duration: number;
  exiting: boolean;
}

interface FeedbackContextValue {
  show: (feedback: FeedbackContent & {
    action?: FeedbackAction;
    dedupeKey?: string;
    duration?: number;
  }) => void;
}

const FeedbackContext = createContext<FeedbackContextValue | null>(null);

const EXIT_MS = 150;
const MAX_TOASTS = 5;

function iconFor(severity: FeedbackSeverity) {
  if (severity === "success") return <CheckCircle2 size={16} aria-hidden="true" />;
  if (severity === "warning") return <TriangleAlert size={16} aria-hidden="true" />;
  if (severity === "error") return <AlertCircle size={16} aria-hidden="true" />;
  return <Info size={16} aria-hidden="true" />;
}

function roleFor(severity: FeedbackSeverity) {
  return severity === "error" ? "alert" : "status";
}

function apiErrorTitle(error: ApiError, fallback: string) {
  if (error.code === "E_INTERNAL") return fallback;
  if (error.code === "E_AUTH_UNAVAILABLE") return "Authentication is temporarily unavailable";
  if (error.code === "E_UNAUTHENTICATED") return "Authentication required";
  if (error.code === "E_FORBIDDEN") return "You do not have access";
  if (error.code === "E_BILLING_REQUIRED") return "This action requires a paid plan";
  if (error.code === "E_BILLING_DISABLED") return "Billing is temporarily unavailable";
  if (error.code === "E_BILLING_NOT_CONFIGURED") return "Billing is temporarily unavailable";
  if (error.code === "E_RATE_LIMITED") return "Too many requests";
  if (error.code === "E_TOKEN_BUDGET_EXCEEDED") return "Token budget exceeded";
  if (error.code === "E_KEY_INVALID_FORMAT") return "Check the API key format";
  if (error.code === "E_KEY_PROVIDER_INVALID") return "That API key provider is not supported";
  if (error.code === "E_KEY_NOT_FOUND") return "API key not found";
  if (error.code === "E_KEY_TEST_FAILED") return "Provider test failed";
  if (error.code === "E_MEDIA_NOT_READY") return "This item is not ready yet";
  if (error.code === "E_HIGHLIGHT_CONFLICT") return "That highlight changed. Reload and try again.";
  if (error.code === "E_PDF_PASSWORD_REQUIRED") return "This PDF is password-protected";
  if (error.code === "E_FILE_TOO_LARGE") return "That file is too large";
  if (error.code === "E_CAPTURE_TOO_LARGE") return "That capture is too large";
  if (error.code === "E_INVALID_FILE_TYPE") return "That file type is not supported";
  if (error.code === "E_INGEST_FAILED") return "We couldn't process this item";
  if (error.code === "E_INGEST_TIMEOUT") return "Processing timed out";
  if (error.code === "E_TRANSCRIPT_UNAVAILABLE") return "Transcript unavailable";
  if (error.code === "E_TRANSCRIPTION_FAILED") return "Transcription failed";
  if (error.code === "E_TRANSCRIPTION_TIMEOUT") return "Transcription timed out";
  if (error.code === "E_BROWSE_PROVIDER_UNAVAILABLE") return "Browse is temporarily unavailable";
  if (error.code === "E_PODCAST_PROVIDER_UNAVAILABLE") return "Podcast search is temporarily unavailable";
  if (error.code === "E_LLM_NO_KEY") return "Add an API key to continue";
  if (error.code === "E_LLM_RATE_LIMIT") return "The model provider is rate limiting requests";
  if (error.code === "E_LLM_INVALID_KEY") return "The API key was rejected";
  if (error.code === "E_LLM_PROVIDER_DOWN") return "The model provider is temporarily unavailable";
  if (error.code === "E_LLM_TIMEOUT") return "The model provider timed out";
  if (error.code === "E_LLM_CONTEXT_TOO_LARGE") return "The context is too large";
  if (error.code === "E_MESSAGE_TOO_LONG") return "The message is too long";
  if (error.code === "E_CONTEXT_TOO_LARGE") return "The context is too large";
  if (error.code === "E_MODEL_NOT_AVAILABLE") return "That model is not available";
  if (error.code === "E_CONVERSATION_BUSY") return "This conversation is already responding";
  return fallback;
}

export function toFeedback(
  error: unknown,
  options: { fallback: string; severity?: FeedbackSeverity }
): FeedbackContent {
  if (isApiError(error)) {
    return {
      severity: options.severity ?? "error",
      title: apiErrorTitle(error, options.fallback),
      requestId: error.requestId,
    };
  }

  return {
    severity: options.severity ?? "error",
    title: options.fallback,
  };
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastFeedback[]>([]);
  const toastsRef = useRef<ToastFeedback[]>([]);
  const nextId = useRef(1);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const clearTimer = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      const exitingToasts = toastsRef.current.map((toast) =>
        toast.id === id ? { ...toast, exiting: true } : toast
      );
      toastsRef.current = exitingToasts;
      setToasts(exitingToasts);
      setTimeout(() => {
        const remainingToasts = toastsRef.current.filter((toast) => toast.id !== id);
        toastsRef.current = remainingToasts;
        setToasts(remainingToasts);
      }, EXIT_MS);
    },
    [clearTimer]
  );

  const scheduleDismiss = useCallback(
    (toast: Pick<ToastFeedback, "id" | "duration">) => {
      clearTimer(toast.id);
      if (toast.duration <= 0) return;
      timers.current.set(toast.id, setTimeout(() => dismiss(toast.id), toast.duration));
    },
    [clearTimer, dismiss]
  );

  const show = useCallback(
    (feedback: FeedbackContent & {
      action?: FeedbackAction;
      dedupeKey?: string;
      duration?: number;
    }) => {
      const duration = feedback.duration ?? (feedback.action ? 0 : 5000);
      if (feedback.dedupeKey) {
        const existing = toastsRef.current.find(
          (toast) => toast.dedupeKey === feedback.dedupeKey
        );
        if (existing) {
          const updatedToasts = toastsRef.current.map((toast) =>
            toast.id === existing.id
              ? { ...toast, ...feedback, duration, exiting: false }
              : toast
          );
          toastsRef.current = updatedToasts;
          setToasts(updatedToasts);
          scheduleDismiss({ id: existing.id, duration });
          return;
        }
      }

      const toast = {
        ...feedback,
        id: nextId.current++,
        duration,
        exiting: false,
      };
      const previousToasts = toastsRef.current;
      const nextToasts = [...previousToasts, toast].slice(-MAX_TOASTS);
      for (const previousToast of previousToasts) {
        if (!nextToasts.some((nextToast) => nextToast.id === previousToast.id)) {
          clearTimer(previousToast.id);
        }
      }
      toastsRef.current = nextToasts;
      setToasts(nextToasts);
      scheduleDismiss(toast);
    },
    [clearTimer, scheduleDismiss]
  );
  const value = useMemo(() => ({ show }), [show]);

  useEffect(() => {
    const timerMap = timers.current;
    const pauseHiddenTimers = () => {
      if (document.visibilityState === "hidden") {
        for (const toast of toastsRef.current) {
          clearTimer(toast.id);
        }
        return;
      }
      for (const toast of toastsRef.current) {
        scheduleDismiss(toast);
      }
    };

    document.addEventListener("visibilitychange", pauseHiddenTimers);
    return () => {
      document.removeEventListener("visibilitychange", pauseHiddenTimers);
      for (const timer of timerMap.values()) {
        clearTimeout(timer);
      }
      timerMap.clear();
    };
  }, [clearTimer, scheduleDismiss]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className={styles.toastViewport} aria-label="Notifications">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={`${styles.toast} ${styles[toast.severity]} ${
              toast.exiting ? styles.exiting : ""
            }`}
            role={roleFor(toast.severity)}
            aria-live={toast.severity === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            onMouseEnter={() => clearTimer(toast.id)}
            onFocusCapture={() => clearTimer(toast.id)}
            onMouseLeave={() => scheduleDismiss(toast)}
            onBlurCapture={() => scheduleDismiss(toast)}
          >
            <div className={styles.icon}>{iconFor(toast.severity)}</div>
            <div className={styles.body}>
              <div className={styles.title}>{toast.title}</div>
              {toast.message ? <div className={styles.message}>{toast.message}</div> : null}
              {toast.requestId ? (
                <div className={styles.meta}>Nexus request ID: {toast.requestId}</div>
              ) : null}
              {toast.action ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.action}
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </Button>
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              className={styles.dismiss}
              onClick={() => dismiss(toast.id)}
              aria-label={`Dismiss ${toast.title}`}
            >
              <X size={16} aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
    </FeedbackContext.Provider>
  );
}

export function useFeedback() {
  const context = useContext(FeedbackContext);
  if (!context) {
    throw new Error("useFeedback must be used within a FeedbackProvider");
  }
  return context;
}

export function FeedbackNotice({
  feedback,
  severity,
  title,
  message,
  requestId,
  children,
  className,
}: {
  feedback?: FeedbackContent | null;
  severity?: FeedbackSeverity;
  title?: string;
  message?: string;
  requestId?: string;
  children?: ReactNode;
  className?: string;
}) {
  const resolvedSeverity = feedback?.severity ?? severity ?? "info";
  const resolvedTitle = feedback?.title ?? title;
  const resolvedMessage = feedback?.message ?? message;
  const resolvedRequestId = feedback?.requestId ?? requestId;

  return (
    <div
      className={`${styles.notice} ${styles[resolvedSeverity]} ${className ?? ""}`}
      role={roleFor(resolvedSeverity)}
      aria-live={resolvedSeverity === "error" ? "assertive" : "polite"}
      aria-atomic="true"
    >
      <div className={styles.icon}>{iconFor(resolvedSeverity)}</div>
      <div className={styles.body}>
        {resolvedTitle ? <div className={styles.title}>{resolvedTitle}</div> : children}
        {resolvedMessage ? <div className={styles.message}>{resolvedMessage}</div> : null}
        {resolvedTitle && children ? <div className={styles.message}>{children}</div> : null}
        {resolvedRequestId ? (
          <div className={styles.meta}>Nexus request ID: {resolvedRequestId}</div>
        ) : null}
      </div>
    </div>
  );
}

export function FieldFeedback({
  feedback,
  id,
}: {
  feedback: FeedbackContent | null;
  id?: string;
}) {
  if (!feedback) return null;
  return (
    <div id={id} className={`${styles.field} ${styles[feedback.severity]}`} role="alert">
      {feedback.title}
    </div>
  );
}
