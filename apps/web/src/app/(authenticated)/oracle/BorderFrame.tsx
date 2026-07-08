import styles from "./oracle.module.css";

// Four corner ornaments framing the oracle surface. The thin gold double-line
// of the surface itself supplies the connecting frame; these flourishes catch
// the eye at the corners. Static, monochrome, pointer-events disabled.

const CORNER_PATHS = [
  "M 4 22 Q 4 4, 22 4",
  "M 8 28 Q 14 14, 28 8",
  "M 14 14 m -2 0 a 2 2 0 1 0 4 0 a 2 2 0 1 0 -4 0",
];

export default function BorderFrame() {
  return (
    <div className={styles.borderFrame} aria-hidden="true">
      {(["tl", "tr", "bl", "br"] as const).map((corner) => (
        <svg
          key={corner}
          viewBox="0 0 32 32"
          className={`${styles.borderFrameCorner} ${styles[`borderFrameCorner_${corner}`]}`}
          focusable="false"
        >
          {CORNER_PATHS.map((d, i) => (
            <path key={i} d={d} />
          ))}
        </svg>
      ))}
    </div>
  );
}
