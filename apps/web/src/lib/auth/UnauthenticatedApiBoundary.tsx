"use client";

import {
  createContext,
  useContext,
  useEffect,
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

export function useUnauthenticatedApiHandler(): (error: unknown) => boolean {
  return useContext(UnauthenticatedApiContext);
}

export default function UnauthenticatedApiBoundary({
  children,
}: {
  children: ReactNode;
}) {
  useEffect(() => {
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (handleUnauthenticatedApiError(event.reason)) {
        event.preventDefault();
      }
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);
    return () => {
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return (
    <UnauthenticatedApiContext.Provider value={handleUnauthenticatedApiError}>
      {children}
    </UnauthenticatedApiContext.Provider>
  );
}
