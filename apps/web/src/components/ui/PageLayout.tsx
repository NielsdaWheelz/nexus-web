import type { ReactNode } from "react";
import styles from "./PageLayout.module.css";
import SurfaceHeader, {
  type SurfaceHeaderBackAction,
  type SurfaceHeaderNavigation,
  type SurfaceHeaderOption,
} from "./SurfaceHeader";

interface PageLayoutProps {
  title: string;
  description?: string;
  back?: SurfaceHeaderBackAction;
  navigation?: SurfaceHeaderNavigation;
  options?: SurfaceHeaderOption[];
  meta?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}

export default function PageLayout({
  title,
  description,
  back,
  navigation,
  options,
  meta,
  actions,
  children,
}: PageLayoutProps) {
  return (
    <div className={styles.container}>
      <SurfaceHeader
        title={title}
        subtitle={description}
        back={back}
        navigation={navigation}
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
