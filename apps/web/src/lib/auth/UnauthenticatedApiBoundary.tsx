"use client";
// the one browser-runtime latch that turns a 401 E_UNAUTHENTICATED into
// exactly one login navigation (docs/modules/browser-session-recovery.md).
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { isUnauthenticatedApiError } from "@/lib/api/client";
import { loginPath, parseReturnTarget } from "@/lib/auth/urls";

let redirectStarted = false;

export function handleUnauthenticatedApiError(error: unknown): boolean {
  if (!isUnauthenticatedApiError(error)) return false;
  if (redirectStarted) return true;
  if (typeof window === "undefined" || window.location.pathname === "/login") {
    return false;
  }
  const { pathname, search } = window.location;
  window.location.assign(loginPath(parseReturnTarget(`${pathname}${search}`)));
  redirectStarted = true;
  return true;
}

// outside the authenticated shell the handler is a no-op: share capture
// relies on it.
const Context = createContext<(error: unknown) => boolean>(() => false);

export function useUnauthenticatedApiHandler(): (error: unknown) => boolean {
  return useContext(Context);
}

export default function UnauthenticatedApiBoundary({
  children,
}: {
  children: ReactNode;
}) {
  useEffect(() => {
    const onRejection = (event: PromiseRejectionEvent) => {
      if (handleUnauthenticatedApiError(event.reason)) event.preventDefault();
    };
    window.addEventListener("unhandledrejection", onRejection);
    return () => window.removeEventListener("unhandledrejection", onRejection);
  }, []);
  return (
    <Context.Provider value={handleUnauthenticatedApiError}>
      {children}
    </Context.Provider>
  );
}
