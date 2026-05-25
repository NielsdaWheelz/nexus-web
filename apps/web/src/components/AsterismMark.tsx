import type { SVGProps } from "react";

interface AsterismMarkProps extends Omit<SVGProps<SVGSVGElement>, "color"> {
  size?: number | string;
  color?: string;
  title?: string;
}

export default function AsterismMark({
  size = 24,
  color = "currentColor",
  title,
  ...rest
}: AsterismMarkProps) {
  const labelled = Boolean(title);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      fill={color}
      role={labelled ? "img" : "presentation"}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...rest}
    >
      {labelled ? <title>{title}</title> : null}
      <circle cx="32" cy="18" r="6.5" />
      <circle cx="18" cy="44" r="5.5" />
      <circle cx="46" cy="44" r="5.5" />
    </svg>
  );
}
