import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { buildMediaImageProxySrc } from "@/lib/media/imageProxy";
import { buildOraclePlateImageSrc } from "@/lib/media/oraclePlateImage";
import MediaImage from "./MediaImage";

describe("MediaImage", () => {
  it("kind=owned renders the src verbatim without routing through the proxy", () => {
    const src = buildOraclePlateImageSrc("123e4567-e89b-12d3-a456-426614174000");
    render(
      <MediaImage
        kind="owned"
        src={src}
        alt="plate"
        width={36}
        height={48}
      />,
    );

    const img = screen.getByRole("img", { name: "plate" });
    expect(img).toHaveAttribute("src", src);
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
    expect(img).toHaveAttribute("src", buildMediaImageProxySrc(remoteUrl));
    expect(img).toHaveAttribute("data-unoptimized");
  });
});
