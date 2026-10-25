"use client";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useMemo, useRef, type ReactNode } from "react";
import { HostPolicyProvider, type HostPolicy } from "./policy";

// Next installs its history patch after layout effects; retain its projection
// repair here, where Next's router lifetime belongs.
export default function HostedPolicy({ children }: { children: ReactNode }) {
  const router = useRouter();
  const projected = useRef<string | null>(null);
  const policy = useMemo<HostPolicy>(() => ({
    Image,
    recover: () => router.refresh(),
    project(href) {
      projected.current = href;
      window.history.replaceState(null, "", href);
      requestAnimationFrame(() => {
        if (projected.current === href && Object.hasOwn(window.history, "replaceState")) window.history.replaceState(null, "", href);
      });
    },
  }), [router]);
  return <HostPolicyProvider value={policy}>{children}</HostPolicyProvider>;
}
