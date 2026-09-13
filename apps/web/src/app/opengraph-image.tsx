import { ImageResponse } from "next/og";
import {
  ASTERISM_DOTS,
  ASTERISM_VIEWBOX,
  BRAND_BG_DARK,
  BRAND_FG_ON_DARK,
} from "@/lib/brand";

export const alt = "Nexus — A reading and notes platform";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          background: BRAND_BG_DARK,
          color: "#ededef",
          fontFamily: "serif",
          gap: 36,
        }}
      >
        <svg
          width="220"
          height="220"
          viewBox={`0 0 ${ASTERISM_VIEWBOX} ${ASTERISM_VIEWBOX}`}
          xmlns="http://www.w3.org/2000/svg"
        >
          {ASTERISM_DOTS.map((d, i) => (
            <circle key={i} cx={d.cx} cy={d.cy} r={d.r} fill={BRAND_FG_ON_DARK} />
          ))}
        </svg>
        <div
          style={{
            fontSize: 112,
            fontWeight: 500,
            letterSpacing: "-0.01em",
            color: "#ededef",
          }}
        >
          Nexus
        </div>
        <div
          style={{
            fontSize: 30,
            color: "#a3a3a8",
            letterSpacing: "0.02em",
            fontStyle: "italic",
          }}
        >
          A reading and notes platform
        </div>
      </div>
    ),
    { ...size },
  );
}
