import { cx } from "@/lib/ui/cx";
import styles from "./LibraryColorDot.module.css";

type LibraryColorDotSize = "sm" | "md";

interface LibraryColorDotProps {
  color?: string | null;
  size?: LibraryColorDotSize;
  className?: string;
}

const sizeClass: Record<LibraryColorDotSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
};

export default function LibraryColorDot({
  color,
  size = "md",
  className,
}: LibraryColorDotProps) {
  if (!color) {
    return null;
  }

  return (
    <span
      className={cx(styles.dot, sizeClass[size], className)}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}
