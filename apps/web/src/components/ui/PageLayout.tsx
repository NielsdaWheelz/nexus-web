import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useIsMobileViewport } from "@/lib/ui/useIsMobileViewport";
import { useMobileChromeVisibility } from "@/lib/ui/useMobileChromeVisibility";
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
  const [mobileHeaderHeight, setMobileHeaderHeight] = useState(0);
  const headerRef = useRef<HTMLElement>(null);
  const { mobileChromeHidden: mobileHeaderHidden, onContentScroll } =
    useMobileChromeVisibility(isMobileViewport, true);

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
      data-testid="page-layout-container"
      onScroll={onContentScroll}
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
