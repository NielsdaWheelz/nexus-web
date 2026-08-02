import type { ReaderDocumentOverviewRange } from "@/lib/reader/readerDocumentPosition";
import styles from "./MobileReaderPositionRibbon.module.css";

export default function MobileReaderPositionRibbon({
  visibleRange,
}: {
  readonly visibleRange: ReaderDocumentOverviewRange;
}) {
  return (
    <div
      className={styles.ribbon}
      data-testid="mobile-reader-position-ribbon"
      aria-hidden="true"
    >
      <div
        className={styles.band}
        data-testid="mobile-reader-position-band"
        style={{
          insetInlineStart: `min(${visibleRange.start * 100}%, calc(100% - 2px))`,
          inlineSize: `max(2px, ${(visibleRange.end - visibleRange.start) * 100}%)`,
        }}
      />
    </div>
  );
}
