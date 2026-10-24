"use client";
import { useSyncExternalStore } from "react";
import type { RemoteAdmission } from "./contracts";
import { subscribeAdmission, remoteAdmission, remoteGeneration } from "./admission";

export function useRemoteAdmission(): RemoteAdmission {
  return useSyncExternalStore(subscribeAdmission, remoteAdmission, remoteAdmission);
}
export function useRemoteGeneration(): number {
  return useSyncExternalStore(subscribeAdmission, remoteGeneration, remoteGeneration);
}
