"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  type ReactNode,
} from "react";
import { isUnauthenticatedApiError } from "@/lib/api/client";
import { redirectToLoginForCurrentLocation } from "@/lib/auth/client-return-target";

const UnauthenticatedApiContext = createContext<(error: unknown) => boolean>(
  () => false
);

let unauthenticatedApiRedirectStarted = false;

export function handleUnauthenticatedApiError(error: unknown): boolean {
  if (!isUnauthenticatedApiError(error)) {
    return false;
  }

  if (unauthenticatedApiRedirectStarted) {
    return true;
  }

  if (redirectToLoginForCurrentLocation()) {
    unauthenticatedApiRedirectStarted = true;
    return true;
  }
  return false;
}

export function __resetUnauthenticatedApiRedirectForTests(): void {
  unauthenticatedApiRedirectStarted = false;
}

export function useUnauthenticatedApiHandler(): (error: unknown) => boolean {
  return useContext(UnauthenticatedApiContext);
}

export default function UnauthenticatedApiBoundary({
  children,
}: {
  children: ReactNode;
}) {
  const redirectedRef = useRef(false);
  const handle = useCallback((error: unknown) => {
    if (redirectedRef.current) {
      return false;
    }

    if (handleUnauthenticatedApiError(error)) {
      redirectedRef.current = true;
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (handle(event.reason)) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, [handle]);

  return (
    <UnauthenticatedApiContext.Provider value={handle}>
      {children}
    </UnauthenticatedApiContext.Provider>
  );
}
