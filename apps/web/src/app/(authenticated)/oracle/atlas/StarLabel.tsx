import { toRoman } from "@/lib/toRoman";
import type { FolioStar } from "./projection";
import styles from "./atlas.module.css";

/** Corner marginalia label for the focused star: roman numeral + motto + theme. */
export default function StarLabel({
  focused,
  selectedId,
  peerIds,
}: {
  focused: FolioStar;
  selectedId: string | null;
  peerIds: readonly string[];
}) {
  return (
    <div className={styles.starLabel} aria-live="polite">
      <span className={styles.starLabelFolio}>Folio {toRoman(focused.folio_number)}</span>
      {focused.folio_motto && (
        <span className={styles.starLabelMotto}>{focused.folio_motto}</span>
      )}
      {focused.folio_theme && (
        <span className={styles.starLabelTheme}>{focused.folio_theme}</span>
      )}
      {selectedId === focused.id && (
        <span className={styles.starLabelHint}>
          {peerIds.length > 0
            ? `Constellation of ${peerIds.length} · click again to enter`
            : "click again to enter"}
        </span>
      )}
    </div>
  );
}
