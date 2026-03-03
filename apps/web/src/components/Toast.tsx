"use client";

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useRef,
} from "react";
import styles from "./Toast.module.css";

// =============================================================================
// Types
// =============================================================================

type ToastVariant = "error" | "warning" | "success" | "info";

interface ToastOptions {
  variant: ToastVariant;
  message: string;
  /** Auto-dismiss duration in ms. Default 5000. Set 0 to disable. */
  duration?: number;
}

interface ToastEntry extends ToastOptions {
  id: number;
  exiting: boolean;
}

interface ToastContextValue {
  toast: (options: ToastOptions) => void;
}

// =============================================================================
// Context
// =============================================================================

const ToastContext = createContext<ToastContextValue | null>(null);

const MAX_VISIBLE = 5;
const EXIT_DURATION = 150; // must match CSS slideOut duration

// =============================================================================
// Provider
// =============================================================================

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    // Mark as exiting first for animation
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );
    // Remove after animation completes
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, EXIT_DURATION);
  }, []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = nextId.current++;
      const duration = options.duration ?? 5000;

      setToasts((prev) => {
        const next = [...prev, { ...options, id, exiting: false }];
        // Evict oldest if over max
        if (next.length > MAX_VISIBLE) {
          return next.slice(next.length - MAX_VISIBLE);
        }
        return next;
      });

      if (duration > 0) {
        setTimeout(() => dismiss(id), duration);
      }
    },
    [dismiss]
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {toasts.length > 0 && (
        <div className={styles.container}>
          {toasts.map((t) => (
            <div
              key={t.id}
              className={`${styles.toast} ${styles[t.variant]} ${t.exiting ? styles.exiting : ""}`}
              role="alert"
            >
              <span className={styles.message}>{t.message}</span>
              <button
                type="button"
                className={styles.closeButton}
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </ToastContext.Provider>
  );
}

// =============================================================================
// Hook
// =============================================================================

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}
