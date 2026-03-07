import { createRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TranscriptMediaPane, {
  isAllowedYoutubeEmbedUrl,
  type TranscriptFragment,
  type TranscriptPlaybackSource,
} from "./TranscriptMediaPane";

const mockSetTrack = vi.fn();
const mockSeekToMs = vi.fn();
const mockPlay = vi.fn();

vi.mock("@/lib/player/globalPlayer", () => ({
  useGlobalPlayer: () => ({
    track: null,
    setTrack: mockSetTrack,
    clearTrack: vi.fn(),
    seekToMs: mockSeekToMs,
    play: mockPlay,
    pause: vi.fn(),
    isPlaying: false,
    currentTimeSeconds: 0,
    durationSeconds: 0,
    bindAudioElement: vi.fn(),
  }),
}));

beforeEach(() => {
  mockSetTrack.mockReset();
  mockSeekToMs.mockReset();
  mockPlay.mockReset();
});

const VIDEO_PLAYBACK_SOURCE: TranscriptPlaybackSource = {
  kind: "external_video",
  stream_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  source_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  provider: "youtube",
  provider_video_id: "dQw4w9WgXcQ",
  watch_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  embed_url: "https://www.youtube.com/embed/dQw4w9WgXcQ",
};

const PODCAST_PLAYBACK_SOURCE: TranscriptPlaybackSource = {
  kind: "external_audio",
  stream_url: "https://cdn.example.com/e2e/episode.mp3",
  source_url: "https://example.com/podcasts/e2e-episode",
};

const FRAGMENTS: TranscriptFragment[] = [
  {
    id: "frag-1",
    canonical_text: "intro segment",
    t_start_ms: 0,
    t_end_ms: 5_000,
    speaker_label: "Host",
  },
  {
    id: "frag-2",
    canonical_text: "deep dive segment",
    t_start_ms: 12_000,
    t_end_ms: 20_000,
    speaker_label: "Guest",
  },
];

function renderStatefulVideoPane(
  options: {
    playbackSource?: TranscriptPlaybackSource | null;
    isPlaybackOnlyTranscript?: boolean;
    canRead?: boolean;
    processingStatus?: string;
    fragments?: TranscriptFragment[];
  } = {}
) {
  const onSegmentSelect = vi.fn();
  const contentRef = createRef<HTMLDivElement>();
  const fragments = options.fragments ?? FRAGMENTS;

  function Harness() {
    const [activeId, setActiveId] = useState<string | null>(fragments[0]?.id ?? null);
    const activeFragment =
      fragments.find((fragment) => fragment.id === activeId) ?? null;

    return (
      <TranscriptMediaPane
        mediaId="media-video-1"
        mediaTitle="Video Episode"
        mediaKind="video"
        playbackSource={options.playbackSource ?? VIDEO_PLAYBACK_SOURCE}
        canonicalSourceUrl="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        isPlaybackOnlyTranscript={options.isPlaybackOnlyTranscript ?? false}
        canRead={options.canRead ?? true}
        processingStatus={options.processingStatus ?? "ready_for_reading"}
        fragments={fragments}
        activeFragment={activeFragment}
        renderedHtml="<p>active transcript html</p>"
        contentRef={contentRef}
        onSegmentSelect={(fragment) => {
          setActiveId(fragment.id);
          onSegmentSelect(fragment);
        }}
        onContentClick={vi.fn()}
      />
    );
  }

  const utils = render(<Harness />);
  return { ...utils, onSegmentSelect };
}

function renderStatefulPodcastPane(
  options: {
    playbackSource?: TranscriptPlaybackSource | null;
    isPlaybackOnlyTranscript?: boolean;
    canRead?: boolean;
    processingStatus?: string;
    fragments?: TranscriptFragment[];
  } = {}
) {
  const onSegmentSelect = vi.fn();
  const contentRef = createRef<HTMLDivElement>();
  const fragments = options.fragments ?? FRAGMENTS;

  function Harness() {
    const [activeId, setActiveId] = useState<string | null>(fragments[0]?.id ?? null);
    const activeFragment =
      fragments.find((fragment) => fragment.id === activeId) ?? null;

    return (
      <TranscriptMediaPane
        mediaId="media-podcast-1"
        mediaTitle="Podcast Episode"
        mediaKind="podcast_episode"
        playbackSource={options.playbackSource ?? PODCAST_PLAYBACK_SOURCE}
        canonicalSourceUrl="https://example.com/podcasts/e2e-episode"
        isPlaybackOnlyTranscript={options.isPlaybackOnlyTranscript ?? false}
        canRead={options.canRead ?? true}
        processingStatus={options.processingStatus ?? "ready_for_reading"}
        fragments={fragments}
        activeFragment={activeFragment}
        renderedHtml="<p>active transcript html</p>"
        contentRef={contentRef}
        onSegmentSelect={(fragment) => {
          setActiveId(fragment.id);
          onSegmentSelect(fragment);
        }}
        onContentClick={vi.fn()}
      />
    );
  }

  const utils = render(<Harness />);
  return { ...utils, onSegmentSelect };
}

describe("isAllowedYoutubeEmbedUrl", () => {
  it("accepts strict https youtube embed urls", () => {
    expect(
      isAllowedYoutubeEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")
    ).toBe(true);
    expect(
      isAllowedYoutubeEmbedUrl("https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ")
    ).toBe(true);
  });

  it("rejects non-embed, non-https, and credentialed urls", () => {
    expect(
      isAllowedYoutubeEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
    ).toBe(false);
    expect(
      isAllowedYoutubeEmbedUrl("http://www.youtube.com/embed/dQw4w9WgXcQ")
    ).toBe(false);
    expect(
      isAllowedYoutubeEmbedUrl("https://evil.example.com/embed/dQw4w9WgXcQ")
    ).toBe(false);
    expect(
      isAllowedYoutubeEmbedUrl("https://user:pass@www.youtube.com/embed/dQw4w9WgXcQ")
    ).toBe(false);
  });
});

describe("TranscriptMediaPane video playback", () => {
  it("renders a youtube iframe and seeks deterministically on transcript click", async () => {
    const user = userEvent.setup();
    const { onSegmentSelect } = renderStatefulVideoPane();

    const iframe = screen.getByTitle("YouTube video player");
    expect(iframe).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /deep dive segment/i }));

    expect(onSegmentSelect).toHaveBeenCalledTimes(1);
    expect(onSegmentSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "frag-2", t_start_ms: 12_000 })
    );

    await waitFor(() => {
      const nextIframe = screen.getByTitle("YouTube video player") as HTMLIFrameElement;
      const parsed = new URL(nextIframe.src);
      expect(parsed.searchParams.get("start")).toBe("12");
    });
  });

  it("shows explicit source fallback action when embed playback errors", () => {
    renderStatefulVideoPane();

    const iframe = screen.getByTitle("YouTube video player");
    fireEvent.error(iframe);

    expect(screen.getByRole("link", { name: /open in source/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /intro segment/i })).toBeVisible();
  });

  it("keeps transcript-dependent actions gated for playback-only transcript-unavailable video", () => {
    renderStatefulVideoPane({
      isPlaybackOnlyTranscript: true,
      canRead: false,
      processingStatus: "failed",
      fragments: [],
    });

    expect(
      screen.getByText("Transcript unavailable for this episode.")
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /segment/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Send to chat")).not.toBeInTheDocument();
  });

  it("fails closed when embed_url is missing instead of parsing watch urls client-side", () => {
    renderStatefulVideoPane({
      playbackSource: {
        ...VIDEO_PLAYBACK_SOURCE,
        embed_url: null,
      },
    });

    expect(screen.queryByTitle("YouTube video player")).toBeNull();
    expect(screen.getByText("In-app video playback is unavailable.")).toBeVisible();
    expect(screen.getByRole("link", { name: /open in source/i })).toBeVisible();
  });
});

describe("TranscriptMediaPane podcast playback", () => {
  it("routes transcript click-to-seek into the global footer player", async () => {
    const user = userEvent.setup();
    const { onSegmentSelect } = renderStatefulPodcastPane();

    expect(
      screen.getByRole("button", { name: "Play in footer" })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /deep dive segment/i }));

    expect(onSegmentSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "frag-2", t_start_ms: 12_000 })
    );
    expect(mockSeekToMs).toHaveBeenCalledWith(12_000);
    expect(mockPlay).toHaveBeenCalled();
  });
});
