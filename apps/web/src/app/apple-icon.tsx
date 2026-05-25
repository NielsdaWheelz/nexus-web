import { ImageResponse } from "next/og";

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
          background: "#15140f",
        }}
      >
        <svg
          width="124"
          height="124"
          viewBox="0 0 64 64"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="32" cy="22" r="8.5" fill="#c4a472" />
          <circle cx="22" cy="40" r="8.5" fill="#c4a472" />
          <circle cx="42" cy="40" r="8.5" fill="#c4a472" />
        </svg>
      </div>
    ),
    { ...size },
  );
}
