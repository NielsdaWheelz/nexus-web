import type { CSSProperties, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import styles from "./PageLayout.module.css";
import SurfaceHeader, {
  type SurfaceHeaderOption,
} from "./SurfaceHeader";

interface PageLayoutProps {
  title: string;
  description?: string;
  options?: SurfaceHeaderOption[];
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

type PageLayoutStyle = CSSProperties & {
  "--mobile-page-header-height"?: string;
};

export default function PageLayout({
  title,
  description,
  options,
  meta,
  actions,
  children,
}: PageLayoutProps) {
  const isMobileViewport = useIsMobileViewport();
  const [mobileHeaderHidden, setMobileHeaderHidden] = useState(false);
  const [mobileHeaderHeight, setMobileHeaderHeight] = useState(0);
  const headerRef = useRef<HTMLElement>(null);
  const lastScrollTopRef = useRef(0);

  useEffect(() => {
    if (!isMobileViewport) {
      setMobileHeaderHidden(false);
      lastScrollTopRef.current = 0;
    }
  }, [isMobileViewport]);

  useEffect(() => {
    if (!isMobileViewport || !headerRef.current) {
      setMobileHeaderHeight(0);
      return;
    }
    const node = headerRef.current;
    const update = () => {
      setMobileHeaderHeight(Math.max(0, Math.round(node.getBoundingClientRect().height)));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [isMobileViewport, title, description, options, meta, actions]);

  const handleScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      if (!isMobileViewport) {
        return;
      }
      const scrollTop = event.currentTarget.scrollTop;
      const previous = lastScrollTopRef.current;
      const delta = scrollTop - previous;
      lastScrollTopRef.current = scrollTop;

      if (scrollTop <= 24) {
        setMobileHeaderHidden(false);
        return;
      }
      if (delta >= 10) {
        setMobileHeaderHidden(true);
        return;
      }
      if (delta <= -10) {
        setMobileHeaderHidden(false);
      }
    },
    [isMobileViewport]
  );

  const className = `${styles.container} ${
    isMobileViewport
      ? mobileHeaderHidden
        ? styles.mobileHeaderHidden
        : styles.mobileHeaderVisible
      : ""
  }`.trim();
  const style: PageLayoutStyle = {};
  if (isMobileViewport && mobileHeaderHeight > 0) {
    style["--mobile-page-header-height"] = `${mobileHeaderHeight}px`;
  }

  return (
    <div
      className={className}
      onScroll={handleScroll}
      style={Object.keys(style).length > 0 ? style : undefined}
    >
      <SurfaceHeader
        ref={headerRef}
        title={title}
        subtitle={description}
        options={options}
        actions={actions}
        meta={meta}
        headingLevel={1}
        className={styles.header}
      />
      <div className={styles.content}>{children}</div>
    </div>
  );
}
