import type { ReactNode } from "react";
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

export default function PageLayout({
  title,
  description,
  options,
  meta,
  actions,
  children,
}: PageLayoutProps) {
  const className = styles.container;

  return (
    <div
      className={className}
      data-testid="page-layout-container"
    >
      <SurfaceHeader
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
