import { useState } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import GlobalPlayerFooter from "@/components/GlobalPlayerFooter";
import { GlobalPlayerProvider, useGlobalPlayer } from "@/lib/player/globalPlayer";

function setViewportWidth(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
  window.dispatchEvent(new Event("resize"));
}

function RouteA() {
  const { setTrack } = useGlobalPlayer();
  return (
    <button
      type="button"
      onClick={() =>
        setTrack(
          {
            media_id: "media-123",
            title: "Episode Alpha",
            stream_url: "https://cdn.example.com/episode-alpha.mp3",
            source_url: "https://example.com/episode-alpha",
          },
          { autoplay: false }
        )
      }
    >
      Load episode
    </button>
  );
}

function RouteHarness() {
  const [route, setRoute] = useState<"a" | "b">("a");
  return (
    <GlobalPlayerProvider>
      <button type="button" onClick={() => setRoute("b")}>
        Navigate away
      </button>
      {route === "a" ? <RouteA /> : <p>Route B content</p>}
      <GlobalPlayerFooter />
    </GlobalPlayerProvider>
  );
}

describe("GlobalPlayerFooter", () => {
  beforeEach(() => {
    setViewportWidth(1280);
  });

  it("persists selected track across route changes on desktop", async () => {
    const user = userEvent.setup();
    render(<RouteHarness />);

    await user.click(screen.getByRole("button", { name: "Load episode" }));
    expect(await screen.findByText("Episode Alpha")).toBeInTheDocument();

    const audio = screen.getByLabelText("Global podcast player") as HTMLAudioElement;
    expect(audio.src).toContain("episode-alpha.mp3");

    await user.click(screen.getByRole("button", { name: "Navigate away" }));
    expect(screen.getByText("Route B content")).toBeInTheDocument();
    expect(screen.getByText("Episode Alpha")).toBeInTheDocument();
    expect(screen.getByLabelText("Global podcast player")).toBeInTheDocument();
  });

  it("switches footer presentation to mobile mode", async () => {
    const user = userEvent.setup();
    setViewportWidth(390);
    render(<RouteHarness />);

    await user.click(screen.getByRole("button", { name: "Load episode" }));
    await waitFor(() => {
      const footer = screen.getByRole("contentinfo", { name: "Global player footer" });
      expect(footer).toHaveAttribute("data-mobile", "true");
    });
  });
});
