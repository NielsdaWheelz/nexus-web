import { forwardRef, type HTMLAttributes } from "react";
import Image from "next/image";
import styles from "./Avatar.module.css";

type AvatarSize = "sm" | "md" | "lg";

interface AvatarProps extends HTMLAttributes<HTMLDivElement> {
  size?: AvatarSize;
  src?: string;
  alt?: string;
  initials?: string;
  seed?: string;
}

const sizeClass: Record<AvatarSize, string> = {
  sm: styles.sizeSm,
  md: styles.sizeMd,
  lg: styles.sizeLg,
};

const sizePixels: Record<AvatarSize, number> = {
  sm: 32,
  md: 36,
  lg: 44,
};

function seedToHue(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

const Avatar = forwardRef<HTMLDivElement, AvatarProps>(function Avatar(
  {
    size = "md",
    src,
    alt = "",
    initials,
    seed,
    className,
    style,
    ...rest
  },
  ref
) {
  const cls = [styles.avatar, sizeClass[size], className ?? ""]
    .filter(Boolean)
    .join(" ");

  if (src) {
    const pixels = sizePixels[size];
    return (
      <div ref={ref} className={cls} style={style} {...rest}>
        <Image
          className={styles.image}
          src={src}
          alt={alt}
          width={pixels}
          height={pixels}
          unoptimized
        />
      </div>
    );
  }

  const hue = seedToHue(seed ?? initials ?? "");
  const initialsStyle = { backgroundColor: `hsl(${hue}, 30%, 30%)` };

  return (
    <div ref={ref} className={cls} style={style} {...rest}>
      <span className={styles.initials} style={initialsStyle}>
        {initials ?? ""}
      </span>
    </div>
  );
});

export default Avatar;
export type { AvatarProps, AvatarSize };
