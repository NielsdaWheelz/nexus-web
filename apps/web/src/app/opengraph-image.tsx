import { ImageResponse } from "next/og";

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
          background: "#15140f",
          color: "#ededef",
          fontFamily: "serif",
          gap: 36,
        }}
      >
        <svg
          width="220"
          height="220"
          viewBox="0 0 64 64"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="32" cy="18" r="6.5" fill="#c4a472" />
          <circle cx="18" cy="44" r="5.5" fill="#c4a472" />
          <circle cx="46" cy="44" r="5.5" fill="#c4a472" />
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
