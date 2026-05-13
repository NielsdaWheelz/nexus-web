import styles from "./Separator.module.css";

type SeparatorOrientation = "horizontal" | "vertical";

interface SeparatorProps {
  orientation?: SeparatorOrientation;
  className?: string;
}

export default function Separator({
  orientation = "horizontal",
  className,
}: SeparatorProps) {
  if (orientation === "horizontal") {
    return (
      <hr
        role="separator"
        aria-orientation="horizontal"
        className={[styles.horizontal, className].filter(Boolean).join(" ")}
      />
    );
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={[styles.vertical, className].filter(Boolean).join(" ")}
    />
  );
}

export type { SeparatorProps, SeparatorOrientation };
