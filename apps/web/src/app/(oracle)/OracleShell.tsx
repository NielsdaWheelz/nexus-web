"use client";

import { usePathname } from "next/navigation";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import styles from "./OracleShell.module.css";

const HeadlineContext = createContext<{
  setStickyTitle: (title: string | null) => void;
}>({ setStickyTitle: () => {} });

export function useStickyHeadline(title: string | null): RefObject<HTMLElement | null> {
  const { setStickyTitle } = useContext(HeadlineContext);
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => setStickyTitle(entry!.isIntersecting ? null : title),
      { threshold: 0 },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      setStickyTitle(null);
    };
  }, [title, setStickyTitle]);

  return ref;
}

function derivedBackLink(pathname: string): { label: string; href: string } {
  if (pathname !== "/oracle" && pathname.startsWith("/oracle/")) {
    return { label: "← Index", href: "/oracle" };
  }
  return { label: "← Home", href: "/libraries" };
}

export default function OracleShell({ children }: { children: ReactNode }) {
  const [stickyTitle, setStickyTitle] = useState<string | null>(null);
  const contextValue = useMemo(() => ({ setStickyTitle }), []);
  const pathname = usePathname();
  const { label, href } = derivedBackLink(pathname);

  return (
    <HeadlineContext.Provider value={contextValue}>
      <header className={styles.topBar} role="banner">
        <a href={href} className={styles.back}>
          {label}
        </a>
        <div
          className={styles.title}
          aria-live="polite"
          aria-atomic="true"
        >
          {stickyTitle ?? ""}
        </div>
      </header>
      {children}
    </HeadlineContext.Provider>
  );
}
