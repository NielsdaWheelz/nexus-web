"use client";

import { useEffect, useState } from "react";

export const MOBILE_MAX_WIDTH_PX = 768;

function readIsMobile(maxWidth: number): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  return window.innerWidth <= maxWidth;
}

export function useIsMobileViewport(maxWidth: number = MOBILE_MAX_WIDTH_PX): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => readIsMobile(maxWidth));

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const onResize = () => {
      setIsMobile(readIsMobile(maxWidth));
    };

    onResize();
    window.addEventListener("resize", onResize, { passive: true });
    return () => {
      window.removeEventListener("resize", onResize);
    };
  }, [maxWidth]);

  return isMobile;
}

