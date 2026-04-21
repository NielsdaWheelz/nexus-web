import { createRef, useState, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TranscriptPlaybackPanel, {
  isAllowedYoutubeEmbedUrl,
} from "./TranscriptPlaybackPanel";
import TranscriptContentPanel from "./TranscriptContentPanel";
import TranscriptStatePanel from "./TranscriptStatePanel";
import type {
  TranscriptChapter,
  TranscriptFragment,
  TranscriptPlaybackSource,
  TranscriptRequestForecast,
} from "./mediaHelpers";

const mockSeekToMs = vi.fn();
const mockPlay = vi.fn();
const mockAddToQueue = vi.fn(async () => []);
const mockReaderContentArea = vi.fn(
  ({ children }: { children: ReactNode }) => children
);
let mockCurrentTimeSeconds = 0;
const mockBillingState = vi.hoisted(() => ({
  account: null as
    | {
        billing_enabled: boolean;
        plan_tier: "free" | "plus" | "ai_plus" | "ai_pro";
        subscription_status: string;
        can_share: boolean;
        can_use_platform_llm: boolean;
        current_period_start: string | null;
        current_period_end: string | null;
        ai_token_usage: {
          used: number;
          reserved: number;
          limit: number;
          remaining: number;
          period_start: string;
          period_end: string;
        };
        transcription_usage: {
          used: number;
          reserved: number;
          limit: number;
          remaining: number;
          period_start: string;
          period_end: string;
        };
      }
    | null,
  loading: false,
  error: null as string | null,
  reload: vi.fn(),
}));

vi.mock("next/image", () => ({
  __esModule: true,
  default: (props: {
    alt?: string;
    src?: string;
    width?: number;
    height?: number;
    className?: string;
    unoptimized?: boolean;
  }) => {
    const { unoptimized: _unoptimized, ...imgProps } = props;
    // eslint-disable-next-line @next/next/no-img-element -- test double for next/image
    return <img alt={imgProps.alt ?? ""} {...imgProps} />;
  },
}));

vi.mock("@/components/ReaderContentArea", () => ({
  default: (
    props: {
      children: ReactNode;
      contentClassName?: string;
    }
  ) => mockReaderContentArea(props),
}));

vi.mock("@/components/HtmlRenderer", () => ({
  default: ({
    htmlSanitized,
    className,
  }: {
    htmlSanitized: string;
    className?: string;
  }) => (
    // eslint-disable-next-line react/no-danger -- test mock must render trusted sanitized HTML
    <div className={className} dangerouslySetInnerHTML={{ __html: htmlSanitized }} />
  ),
}));

vi.mock("@/lib/player/globalPlayer", () => ({
  useGlobalPlayer: () => ({
    track: null,
    setTrack: vi.fn(),
    clearTrack: vi.fn(),
    seekToMs: mockSeekToMs,
    play: mockPlay,
    pause: vi.fn(),
    isPlaying: false,
    currentTimeSeconds: mockCurrentTimeSeconds,
    durationSeconds: 0,
    bufferedSeconds: 0,
    playbackRate: 1,
    volume: 1,
    queueItems: [],
    refreshQueue: vi.fn(async () => {}),
    addToQueue: mockAddToQueue,
    removeFromQueue: vi.fn(async () => {}),
    reorderQueue: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => {}),
    playNextInQueue: vi.fn(async () => {}),
    playPreviousInQueue: vi.fn(async () => {}),
    hasNextInQueue: false,
    hasPreviousInQueue: false,
    bindAudioElement: vi.fn(),
  }),
}));

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => mockBillingState,
}));

beforeEach(() => {
  mockSeekToMs.mockReset();
  mockPlay.mockReset();
  mockAddToQueue.mockReset();
  mockAddToQueue.mockResolvedValue([]);
  mockReaderContentArea.mockReset();
  mockReaderContentArea.mockImplementation(
    ({ children }: { children: ReactNode }) => children
  );
  mockCurrentTimeSeconds = 0;
  mockBillingState.account = null;
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

const PODCAST_CHAPTERS: TranscriptChapter[] = [
  {
    chapter_idx: 0,
    title: "Intro",
    t_start_ms: 0,
    t_end_ms: 300_000,
    url: "https://example.com/chapters/intro",
    image_url: "https://cdn.example.com/images/intro.jpg",
  },
  {
    chapter_idx: 1,
    title: "Deep Dive",
    t_start_ms: 300_000,
    t_end_ms: null,
    url: null,
    image_url: null,
  },
];

function renderVideoPanels() {
  const onSegmentSelect = vi.fn();
  const contentRef = createRef<HTMLDivElement>();

  function Harness() {
    const [activeId, setActiveId] = useState<string | null>(FRAGMENTS[0]?.id ?? null);
    const [videoSeekTargetMs, setVideoSeekTargetMs] = useState<number | null>(null);
    const activeFragment =
      FRAGMENTS.find((fragment) => fragment.id === activeId) ?? null;

    return (
      <>
        <TranscriptPlaybackPanel
          mediaId="media-video-1"
          mediaKind="video"
          playbackSource={VIDEO_PLAYBACK_SOURCE}
          canonicalSourceUrl="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
          chapters={[]}
          descriptionHtml={null}
          descriptionText={null}
          videoSeekTargetMs={videoSeekTargetMs}
          onSeek={(timestampMs) => setVideoSeekTargetMs(timestampMs ?? null)}
        />
        <TranscriptContentPanel
          transcriptState="ready"
          transcriptCoverage="full"
          chapters={[]}
          fragments={FRAGMENTS}
          activeFragment={activeFragment}
          renderedHtml="<p>active transcript html</p>"
          contentRef={contentRef}
          onSegmentSelect={(fragment) => {
            setActiveId(fragment.id);
            onSegmentSelect(fragment);
          }}
          onSeek={(timestampMs) => setVideoSeekTargetMs(timestampMs ?? null)}
          onContentClick={vi.fn()}
        />
      </>
    );
  }

  const utils = render(<Harness />);
  return { ...utils, onSegmentSelect };
}

function renderPodcastPlaybackPanel(
  options: {
    chapters?: TranscriptChapter[];
    descriptionHtml?: string | null;
    descriptionText?: string | null;
    playbackSource?: TranscriptPlaybackSource | null;
  } = {}
) {
  return render(
    <TranscriptPlaybackPanel
      mediaId="media-podcast-1"
      mediaKind="podcast_episode"
      playbackSource={options.playbackSource ?? PODCAST_PLAYBACK_SOURCE}
      canonicalSourceUrl="https://example.com/podcasts/e2e-episode"
      chapters={options.chapters ?? []}
      descriptionHtml={options.descriptionHtml ?? null}
      descriptionText={options.descriptionText ?? null}
      videoSeekTargetMs={null}
      onSeek={(timestampMs) => {
        mockSeekToMs(timestampMs);
        mockPlay();
      }}
    />
  );
}

function renderPodcastContentPanel(
  options: {
    transcriptState?: "ready" | "partial" | null;
    transcriptCoverage?: "none" | "partial" | "full" | null;
    chapters?: TranscriptChapter[];
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
      <TranscriptContentPanel
        transcriptState={options.transcriptState ?? "ready"}
        transcriptCoverage={options.transcriptCoverage ?? "full"}
        chapters={options.chapters ?? []}
        fragments={fragments}
        activeFragment={activeFragment}
        renderedHtml="<p>active transcript html</p>"
        contentRef={contentRef}
        onSegmentSelect={(fragment) => {
          setActiveId(fragment.id);
          onSegmentSelect(fragment);
        }}
        onSeek={(timestampMs) => {
          mockSeekToMs(timestampMs);
          mockPlay();
        }}
        onContentClick={vi.fn()}
      />
    );
  }

  const utils = render(<Harness />);
  return { ...utils, onSegmentSelect };
}

function renderStatePanel(
  options: {
    processingStatus?: string;
    transcriptState?:
      | "not_requested"
      | "queued"
      | "running"
      | "failed_provider"
      | "failed_quota"
      | "unavailable"
      | "ready"
      | "partial"
      | null;
    transcriptCoverage?: "none" | "partial" | "full" | null;
    transcriptRequestInFlight?: boolean;
    transcriptRequestForecast?: TranscriptRequestForecast | null;
    onRequestTranscript?: () => void;
  } = {}
) {
  return render(
    <TranscriptStatePanel
      processingStatus={options.processingStatus ?? "pending"}
      transcriptState={options.transcriptState ?? "not_requested"}
      transcriptCoverage={options.transcriptCoverage ?? "none"}
      transcriptRequestInFlight={options.transcriptRequestInFlight ?? false}
      transcriptRequestForecast={options.transcriptRequestForecast ?? null}
      onRequestTranscript={options.onRequestTranscript ?? vi.fn()}
    />
  );
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

describe("Transcript panels video playback", () => {
  it("updates the youtube embed start time when a transcript segment is selected", async () => {
    const user = userEvent.setup();
    const { onSegmentSelect } = renderVideoPanels();

    expect(screen.getByTitle("YouTube video player")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /deep dive segment/i }));

    expect(onSegmentSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "frag-2", t_start_ms: 12_000 })
    );

    await waitFor(() => {
      const iframe = screen.getByTitle("YouTube video player") as HTMLIFrameElement;
      const parsed = new URL(iframe.src);
      expect(parsed.searchParams.get("start")).toBe("12");
    });
  });

  it("shows the source fallback when the embedded player errors", () => {
    render(
      <TranscriptPlaybackPanel
        mediaId="media-video-1"
        mediaKind="video"
        playbackSource={VIDEO_PLAYBACK_SOURCE}
        canonicalSourceUrl="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        chapters={[]}
        descriptionHtml={null}
        descriptionText={null}
        videoSeekTargetMs={null}
        onSeek={vi.fn()}
      />
    );

    fireEvent.error(screen.getByTitle("YouTube video player"));

    expect(screen.getByRole("link", { name: /open in source/i })).toBeVisible();
  });

  it("fails closed when embed_url is missing instead of parsing watch urls client-side", () => {
    render(
      <TranscriptPlaybackPanel
        mediaId="media-video-1"
        mediaKind="video"
        playbackSource={{ ...VIDEO_PLAYBACK_SOURCE, embed_url: null }}
        canonicalSourceUrl="https://www.youtube.com/watch?v=dQw4w9WgXcQ"
        chapters={[]}
        descriptionHtml={null}
        descriptionText={null}
        videoSeekTargetMs={null}
        onSeek={vi.fn()}
      />
    );

    expect(screen.queryByTitle("YouTube video player")).toBeNull();
    expect(screen.getByText("In-app video playback is unavailable.")).toBeVisible();
    expect(screen.getByRole("link", { name: /open in source/i })).toBeVisible();
  });
});

describe("Transcript playback panel podcast behavior", () => {
  it("renders play-next/add-to-queue actions and delegates queue intent to the player", async () => {
    const user = userEvent.setup();
    renderPodcastPlaybackPanel();

    expect(screen.getByRole("button", { name: /play next/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /add to queue/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /play next/i }));
    await user.click(screen.getByRole("button", { name: /add to queue/i }));

    expect(mockAddToQueue).toHaveBeenNthCalledWith(1, "media-podcast-1", "next");
    expect(mockAddToQueue).toHaveBeenNthCalledWith(2, "media-podcast-1", "last");
  });

  it("renders chapter list with links/images and seeks via chapter click", async () => {
    const user = userEvent.setup();
    renderPodcastPlaybackPanel({ chapters: PODCAST_CHAPTERS });

    expect(screen.getByRole("heading", { name: "Chapters" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Intro" })).toHaveAttribute(
      "href",
      "https://example.com/chapters/intro"
    );
    expect(screen.getByRole("img", { name: "Intro thumbnail" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Jump to chapter 2: Deep Dive" }));
    expect(mockSeekToMs).toHaveBeenCalledWith(300_000);
    expect(mockPlay).toHaveBeenCalled();
  });

  it("highlights the active chapter from playback time", () => {
    mockCurrentTimeSeconds = 360;
    renderPodcastPlaybackPanel({ chapters: PODCAST_CHAPTERS });

    expect(
      screen.getByRole("button", { name: "Jump to chapter 2: Deep Dive" })
    ).toHaveAttribute("aria-current", "true");
  });

  it("renders show notes html and timestamp links seek active podcast playback", async () => {
    const user = userEvent.setup();
    renderPodcastPlaybackPanel({
      chapters: PODCAST_CHAPTERS,
      descriptionHtml:
        "<p>Intro starts at 00:30 and guest interview at 12:30.</p><a href=\"https://example.com/notes\" target=\"_blank\" rel=\"noopener noreferrer\">Episode Notes</a><img src=\"https://cdn.example.com/show-notes.jpg\" alt=\"cover\" />",
      descriptionText: "unused fallback",
    });

    expect(screen.getByRole("heading", { name: "Show Notes" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Episode Notes" })).toHaveAttribute(
      "href",
      "https://example.com/notes"
    );
    expect(screen.getByRole("img", { name: "cover" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Seek to 00:30" }));
    expect(mockSeekToMs).toHaveBeenCalledWith(30_000);
    expect(mockPlay).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Seek to 12:30" }));
    expect(mockSeekToMs).toHaveBeenCalledWith(750_000);
  });

  it("falls back to plain text show notes when html is absent", () => {
    renderPodcastPlaybackPanel({
      descriptionHtml: null,
      descriptionText: "line one\nline two",
    });

    expect(screen.getByRole("heading", { name: "Show Notes" })).toBeVisible();
    expect(screen.getByText("line one")).toBeVisible();
    expect(screen.getByText("line two")).toBeVisible();
  });

  it("omits chapter UI when the episode has no chapters", () => {
    renderPodcastPlaybackPanel({ chapters: [] });

    expect(screen.queryByRole("heading", { name: "Chapters" })).not.toBeInTheDocument();
  });
});

describe("Transcript content panel", () => {
  it("routes transcript click-to-seek into the player callback", async () => {
    const user = userEvent.setup();
    const { onSegmentSelect } = renderPodcastContentPanel();

    await user.click(screen.getByRole("button", { name: /deep dive segment/i }));

    expect(onSegmentSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: "frag-2", t_start_ms: 12_000 })
    );
    expect(mockSeekToMs).toHaveBeenCalledWith(12_000);
    expect(mockPlay).toHaveBeenCalled();
  });

  it("warns when readable transcript coverage is partial", () => {
    renderPodcastContentPanel({
      transcriptState: "partial",
      transcriptCoverage: "partial",
    });

    expect(
      screen.getByText("Transcript is partial; search and highlights may miss sections.")
    ).toBeVisible();
  });

  it("renders inline chapter headings from the normalized timeline", () => {
    renderPodcastContentPanel({ chapters: PODCAST_CHAPTERS });

    expect(screen.getByText("Chapter 1: Intro")).toBeVisible();
    expect(screen.getByText("Chapter 2: Deep Dive")).toBeVisible();
  });

  it("renders active transcript html through the shared reader surface", () => {
    renderPodcastContentPanel();

    expect(mockReaderContentArea).toHaveBeenCalledTimes(1);
    expect(screen.getByText("active transcript html")).toBeVisible();
  });
});

describe("Transcript state panel", () => {
  it("shows explicit on-demand transcription controls with budget forecast", async () => {
    const user = userEvent.setup();
    const onRequestTranscript = vi.fn();
    renderStatePanel({
      transcriptRequestForecast: {
        requiredMinutes: 3,
        remainingMinutes: 7,
        fitsBudget: true,
      },
      onRequestTranscript,
    });

    expect(screen.getByRole("button", { name: /transcribe this episode/i })).toBeVisible();
    expect(screen.getByText("Estimated cost: 3 min")).toBeVisible();
    expect(screen.getByText("Remaining this month: 7 min")).toBeVisible();

    await user.click(screen.getByRole("button", { name: /transcribe this episode/i }));
    expect(onRequestTranscript).toHaveBeenCalledTimes(1);
  });

  it("renders queued and running provisioning states", () => {
    const { rerender } = renderStatePanel({
      processingStatus: "extracting",
      transcriptState: "queued",
    });

    expect(screen.getByText("Transcript request queued.")).toBeVisible();
    expect(screen.getByText("Status: extracting")).toBeVisible();

    rerender(
      <TranscriptStatePanel
        processingStatus="extracting"
        transcriptState="running"
        transcriptCoverage="none"
        transcriptRequestInFlight={false}
        transcriptRequestForecast={null}
        onRequestTranscript={vi.fn()}
      />
    );

    expect(screen.getByText("Transcript transcription is currently running.")).toBeVisible();
  });

  it("renders failed states and disables retry when forecast exceeds quota", () => {
    const { rerender } = renderStatePanel({
      processingStatus: "failed",
      transcriptState: "failed_provider",
    });

    expect(
      screen.getByText("Previous transcription failed. You can retry on demand.")
    ).toBeVisible();

    rerender(
      <TranscriptStatePanel
        processingStatus="failed"
        transcriptState="failed_quota"
        transcriptCoverage="none"
        transcriptRequestInFlight={false}
        transcriptRequestForecast={{
          requiredMinutes: 4,
          remainingMinutes: 1,
          fitsBudget: false,
        }}
        onRequestTranscript={vi.fn()}
      />
    );

    expect(
      screen.getByText("Monthly transcription quota was exceeded for this episode.")
    ).toBeVisible();
    expect(screen.getByText("Not enough monthly transcription quota for this request.")).toBeVisible();
    expect(screen.getByRole("button", { name: /transcribe this episode/i })).toBeDisabled();
  });

  it("renders unavailable state", () => {
    renderStatePanel({
      processingStatus: "failed",
      transcriptState: "unavailable",
    });

    expect(screen.getByText("Transcript unavailable for this episode.")).toBeVisible();
    expect(screen.getByText("Error: E_TRANSCRIPT_UNAVAILABLE")).toBeVisible();
  });

  it("shows the AI plan upgrade copy when transcription is billing-gated", () => {
    mockBillingState.account = {
      billing_enabled: true,
      plan_tier: "plus",
      subscription_status: "active",
      can_share: true,
      can_use_platform_llm: false,
      current_period_start: "2026-04-01T00:00:00Z",
      current_period_end: "2026-05-01T00:00:00Z",
      ai_token_usage: {
        used: 0,
        reserved: 0,
        limit: 0,
        remaining: 0,
        period_start: "2026-04-01T00:00:00Z",
        period_end: "2026-05-01T00:00:00Z",
      },
      transcription_usage: {
        used: 0,
        reserved: 0,
        limit: 0,
        remaining: 0,
        period_start: "2026-04-01T00:00:00Z",
        period_end: "2026-05-01T00:00:00Z",
      },
    };

    renderStatePanel();

    expect(
      screen.getByText("Transcription is included with AI Plus and AI Pro.")
    ).toBeVisible();
    expect(screen.getByText("Current plan: Plus.")).toBeVisible();
    expect(
      screen.getByText("Upgrade in Settings, then come back here to request this transcript.")
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /transcribe this episode/i })).not.toBeInTheDocument();
  });

  it("shows billing-disabled copy when transcription upgrades are unavailable", () => {
    mockBillingState.account = {
      billing_enabled: false,
      plan_tier: "plus",
      subscription_status: "active",
      can_share: true,
      can_use_platform_llm: false,
      current_period_start: "2026-04-01T00:00:00Z",
      current_period_end: "2026-05-01T00:00:00Z",
      ai_token_usage: {
        used: 0,
        reserved: 0,
        limit: 0,
        remaining: 0,
        period_start: "2026-04-01T00:00:00Z",
        period_end: "2026-05-01T00:00:00Z",
      },
      transcription_usage: {
        used: 0,
        reserved: 0,
        limit: 0,
        remaining: 0,
        period_start: "2026-04-01T00:00:00Z",
        period_end: "2026-05-01T00:00:00Z",
      },
    };

    renderStatePanel();

    expect(
      screen.getByText(
        "Billing is temporarily unavailable, so plan upgrades are unavailable right now."
      )
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /transcribe this episode/i })).not.toBeInTheDocument();
  });
});
