import type { SVGProps } from "react";
import { ASTERISM_DOTS, ASTERISM_VIEWBOX } from "@/lib/brand";

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
      viewBox={`0 0 ${ASTERISM_VIEWBOX} ${ASTERISM_VIEWBOX}`}
      width={size}
      height={size}
      fill={color}
      role={labelled ? "img" : "presentation"}
      aria-hidden={labelled ? undefined : true}
      focusable="false"
      {...rest}
    >
      {labelled ? <title>{title}</title> : null}
      {ASTERISM_DOTS.map((d, i) => (
        <circle key={i} cx={d.cx} cy={d.cy} r={d.r} />
      ))}
    </svg>
  );
}
