import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import MediaImage from "./MediaImage";

describe("MediaImage", () => {
  it("kind=owned renders the src verbatim without routing through the proxy", () => {
    render(
      <MediaImage
        kind="owned"
        src="/api/oracle/plates/abc123"
        alt="plate"
        width={36}
        height={48}
      />,
    );

    const img = screen.getByRole("img", { name: "plate" });
    expect(img).toHaveAttribute("src", "/api/oracle/plates/abc123");
    expect(img).not.toHaveAttribute("data-unoptimized");
  });

  it("kind=proxied routes the remote URL through the media image proxy", () => {
    const remoteUrl = "https://example.com/cover.jpg";
    render(
      <MediaImage
        kind="proxied"
        remoteUrl={remoteUrl}
        alt="cover"
        width={40}
        height={40}
      />,
    );

    const img = screen.getByRole("img", { name: "cover" });
    expect(img).toHaveAttribute(
      "src",
      `/api/media/image?url=${encodeURIComponent(remoteUrl)}`,
    );
    expect(img).toHaveAttribute("data-unoptimized");
  });
});
