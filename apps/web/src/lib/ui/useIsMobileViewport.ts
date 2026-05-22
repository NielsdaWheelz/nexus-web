"use client";

import { useEffect, useState } from "react";

export const MOBILE_MAX_WIDTH_PX = 768;

function readIsMobile(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.innerWidth <= MOBILE_MAX_WIDTH_PX;
}

export function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(readIsMobile);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onResize = () => {
      setIsMobile(readIsMobile());
    };

    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return isMobile;
}
