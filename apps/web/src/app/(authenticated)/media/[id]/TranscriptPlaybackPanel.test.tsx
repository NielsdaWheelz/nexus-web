import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import TranscriptPlaybackPanel from "./TranscriptPlaybackPanel";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TranscriptPlaybackPanel", () => {
  it("projects imported show-note headings beneath the panel heading", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ data: { items: [] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(
      <LecternProvider>
        <GlobalPlayerProvider>
          <TranscriptPlaybackPanel
            mediaId="episode-1"
            mediaKind="podcast_episode"
            playbackSource={{
              kind: "external_audio",
              stream_url: "https://media.example/episode.mp3",
              source_url: "https://media.example/episode",
            }}
            canonicalSourceUrl="https://media.example/episode"
            chapters={[
              { chapter_idx: 0, title: "Opening", t_start_ms: 0 },
            ]}
            playerDescriptor={null}
            descriptionHtml={
              '<h1 id="imported-title">Imported title</h1><h2 id="imported-section">Imported section</h2><h6 id="imported-deep">Imported deep heading</h6>'
            }
            videoSeekTargetMs={null}
            onSeek={vi.fn()}
          />
        </GlobalPlayerProvider>
      </LecternProvider>,
    );

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Add to Lectern" })).toBeEnabled(),
    );
    expect(screen.getByRole("heading", { level: 2, name: "Chapters" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 2, name: "Show Notes" })).toBeVisible();
    expect(screen.getByRole("heading", { level: 3, name: "Imported title" })).toHaveAttribute(
      "id",
      "imported-title",
    );
    expect(screen.getByRole("heading", { level: 4, name: "Imported section" })).toHaveAttribute(
      "id",
      "imported-section",
    );
    expect(screen.getByRole("heading", { level: 6, name: "Imported deep heading" })).toHaveAttribute(
      "id",
      "imported-deep",
    );
  });
});
