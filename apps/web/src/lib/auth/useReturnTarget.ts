"use client";

import { useSyncExternalStore } from "react";
import { parseReturnTarget, type ReturnTarget } from "./urls";

function subscribeHash(changed: () => void) {
  window.addEventListener("hashchange", changed);
  return () => window.removeEventListener("hashchange", changed);
}

const currentHash = () => window.location.hash;
const serverHash = () => null;

// the server cannot see an inherited fragment. actions wait until the browser
// supplies it; an explicit fragment in next always wins.
export function useReturnTarget(
  next: ReturnTarget,
): { kind: "Pending" } | { kind: "Ready"; target: ReturnTarget } {
  const hash = useSyncExternalStore<string | null>(
    subscribeHash,
    currentHash,
    serverHash,
  );
  if (hash === null) return { kind: "Pending" };
  const target = new URL(next, "http://localhost");
  if (!target.hash) target.hash = hash;
  return {
    kind: "Ready",
    target: parseReturnTarget(`${target.pathname}${target.search}${target.hash}`),
  };
}
