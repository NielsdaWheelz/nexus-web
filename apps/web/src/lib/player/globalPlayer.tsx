"use client";

import type { ReactNode } from "react";
import { useAndroidShell } from "@/lib/renderEnvironment/provider";
import { AndroidPlayerRuntimeProvider } from "@/lib/player/androidPlayerRuntime";
import { BrowserPlayerRuntimeProvider } from "@/lib/player/browserPlayerRuntime";

export function GlobalPlayerProvider({
  accountId,
  children,
}: {
  accountId?: string;
  children: ReactNode;
}) {
  const androidShell = useAndroidShell();
  if (!androidShell) {
    return (
      <BrowserPlayerRuntimeProvider>
        {children}
      </BrowserPlayerRuntimeProvider>
    );
  }
  if (accountId === undefined) {
    throw new Error(
      "GlobalPlayerProvider requires the verified accountId in the Android shell.",
    );
  }
  return (
    <AndroidPlayerRuntimeProvider key={accountId} accountId={accountId}>
      {children}
    </AndroidPlayerRuntimeProvider>
  );
}
