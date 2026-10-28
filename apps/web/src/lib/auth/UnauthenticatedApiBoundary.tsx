"use client";
// Hosted 401s leave the document once; installed documents retain their owners.
// Recovery is observed at error ingress. True means a login navigation owns the
// error, so callers may stop settling the departing document.
import { createContext, useContext, useEffect, type ReactNode } from "react";
import { isUnauthenticatedApiError } from "@/lib/api/client";
import { installedApp } from "@/lib/native/admission";
import { androidShellDocument } from "@/lib/androidShell";
import { loginPath, parseReturnTarget } from "@/lib/auth/urls";

let redirectStarted = false;
// set across assign: the browser asks its unload guards inside that call.
let tearingDown = false;
let beforeTeardown: (() => void) | null = null;

/** The document ends writing ownership before the login navigation. One holder;
 * the returned function releases it. */
export function beforeSecurityTeardown(stop: () => void): () => void {
  beforeTeardown = stop;
  return () => {
    if (beforeTeardown === stop) beforeTeardown = null;
  };
}

export function handleUnauthenticatedApiError(error: unknown): boolean {
  if (!isUnauthenticatedApiError(error)) return false;
  // A confirmed local workspace survives token expiry on either host.
  if (installedApp || androidShellDocument || (typeof document !== "undefined" && document.getElementById("root") !== null)) return false;
  if (redirectStarted) return true;
  if (typeof window === "undefined" || window.location.pathname === "/login") {
    return false;
  }
  try {
    beforeTeardown?.();
  } catch (failure) {
    // justify-ignore-error: a failed stop never vetoes the security teardown.
    reportError(failure);
  }
  const { pathname, search } = window.location;
  tearingDown = true;
  try {
    window.location.assign(loginPath(parseReturnTarget(`${pathname}${search}`)));
  } catch (failure) {
    tearingDown = false;
    throw failure;
  }
  redirectStarted = true;
  return true;
}

/** The login navigation has started; writing guards yield to it. */
export function securityTeardownStarted(): boolean {
  return tearingDown;
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
      if (handleUnauthenticatedApiError(event.reason) ||
        ((installedApp || androidShellDocument) && isUnauthenticatedApiError(event.reason))) event.preventDefault();
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
