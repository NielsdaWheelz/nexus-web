import { ImageResponse } from "next/og";
import {
  ASTERISM_DOTS,
  ASTERISM_VIEWBOX,
  BRAND_BG_DARK,
  BRAND_FG_ON_DARK,
} from "@/lib/brand";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: BRAND_BG_DARK,
        }}
      >
        <svg
          width="124"
          height="124"
          viewBox={`0 0 ${ASTERISM_VIEWBOX} ${ASTERISM_VIEWBOX}`}
          xmlns="http://www.w3.org/2000/svg"
        >
          {ASTERISM_DOTS.map((d, i) => (
            <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={BRAND_FG_ON_DARK} />
          ))}
        </svg>
      </div>
    ),
    { ...size },
  );
}
