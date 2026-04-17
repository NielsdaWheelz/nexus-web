import { createRef, useState, type ComponentProps, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import TranscriptMediaPane from "./TranscriptMediaPane";
import { isAllowedYoutubeEmbedUrl } from "./TranscriptPlaybackPanel";

type TranscriptMediaPaneProps = ComponentProps<typeof TranscriptMediaPane>;

type TranscriptPlaybackSource = {
  kind: "external_audio" | "external_video";
  stream_url: string;
  source_url: string;
  provider?: string | null;
  provider_video_id?: string | null;
  watch_url?: string | null;
  embed_url?: string | null;
};

type TranscriptFragment = {
  id: string;
  canonical_text: string;
  t_start_ms?: number | null;
  t_end_ms?: number | null;
  speaker_label?: string | null;
};

type TranscriptChapter = {
  chapter_idx: number;
  title: string;
  t_start_ms: number;
  t_end_ms?: number | null;
  url?: string | null;
  image_url?: string | null;
};

type TranscriptState =
  | "not_requested"
  | "queued"
  | "running"
  | "failed_provider"
  | "failed_quota"
  | "unavailable"
  | "ready"
  | "partial";

type TranscriptCoverage = "none" | "partial" | "full";

type TranscriptRequestForecast = {
  requiredMinutes: number;
  remainingMinutes: number | null;
  fitsBudget: boolean;
};

const mockSeekToMs = vi.fn();
const mockPlay = vi.fn();
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
const mockReaderContentArea = vi.fn(
  ({ children }: { children: ReactNode }) => children
);
const mockAddToQueue = vi.fn(async () => []);

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

vi.mock("@/components/ReaderContentArea", () => ({
  default: (
    props: {
      children: ReactNode;
      contentClassName?: string;
    }
  ) => mockReaderContentArea(props),
}));

vi.mock("@/lib/billing/useBillingAccount", () => ({
  useBillingAccount: () => mockBillingState,
}));

beforeEach(() => {
  mockSeekToMs.mockReset();
  mockPlay.mockReset();
  mockReaderContentArea.mockReset();
  mockReaderContentArea.mockImplementation(
    ({ children }: { children: ReactNode }) => children
  );
  mockAddToQueue.mockReset();
  mockAddToQueue.mockResolvedValue([]);
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

function renderStatefulVideoPane(
  options: {
    playbackSource?: TranscriptPlaybackSource | null;
    isPlaybackOnlyTranscript?: boolean;
    canRead?: boolean;
    processingStatus?: string;
    fragments?: TranscriptFragment[];
    transcriptState?: TranscriptState;
    transcriptCoverage?: TranscriptCoverage;
    transcriptRequestInFlight?: boolean;
    transcriptRequestForecast?: TranscriptRequestForecast | null;
    onRequestTranscript?: () => void;
  } = {}
) {
  const onSegmentSelect = vi.fn();
  const contentRef = createRef<HTMLDivElement>();
  const fragments = options.fragments ?? FRAGMENTS;

  function Harness() {
    const [activeId, setActiveId] = useState<string | null>(fragments[0]?.id ?? null);
    const activeFragment =
      fragments.find((fragment) => fragment.id === activeId) ?? null;
    const props = {
      mediaId: "media-video-1",
      mediaKind: "video",
      playbackSource: options.playbackSource ?? VIDEO_PLAYBACK_SOURCE,
      canonicalSourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      isPlaybackOnlyTranscript: options.isPlaybackOnlyTranscript ?? false,
      canRead: options.canRead ?? true,
      processingStatus: options.processingStatus ?? "ready_for_reading",
      transcriptState: options.transcriptState ?? "ready",
      transcriptCoverage: options.transcriptCoverage ?? "full",
      transcriptRequestInFlight: options.transcriptRequestInFlight ?? false,
      transcriptRequestForecast: options.transcriptRequestForecast ?? null,
      chapters: [],
      fragments,
      activeFragment,
      renderedHtml: "<p>active transcript html</p>",
      contentRef,
      onRequestTranscript: options.onRequestTranscript ?? vi.fn(),
      onSegmentSelect: (fragment: TranscriptFragment) => {
        setActiveId(fragment.id);
        onSegmentSelect(fragment);
      },
      onContentClick: vi.fn(),
    } as TranscriptMediaPaneProps;

    return <TranscriptMediaPane {...props} />;
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
    transcriptState?: TranscriptState;
    transcriptCoverage?: TranscriptCoverage;
    transcriptRequestInFlight?: boolean;
    transcriptRequestForecast?: TranscriptRequestForecast | null;
    chapters?: TranscriptChapter[];
    descriptionHtml?: string | null;
    descriptionText?: string | null;
    onRequestTranscript?: () => void;
  } = {}
) {
  const onSegmentSelect = vi.fn();
  const contentRef = createRef<HTMLDivElement>();
  const fragments = options.fragments ?? FRAGMENTS;

  function Harness() {
    const [activeId, setActiveId] = useState<string | null>(fragments[0]?.id ?? null);
    const activeFragment =
      fragments.find((fragment) => fragment.id === activeId) ?? null;
    const props = {
      mediaId: "media-podcast-1",
      mediaKind: "podcast_episode",
      playbackSource: options.playbackSource ?? PODCAST_PLAYBACK_SOURCE,
      canonicalSourceUrl: "https://example.com/podcasts/e2e-episode",
      isPlaybackOnlyTranscript: options.isPlaybackOnlyTranscript ?? false,
      canRead: options.canRead ?? true,
      processingStatus: options.processingStatus ?? "ready_for_reading",
      transcriptState: options.transcriptState ?? "ready",
      transcriptCoverage: options.transcriptCoverage ?? "full",
      transcriptRequestInFlight: options.transcriptRequestInFlight ?? false,
      transcriptRequestForecast: options.transcriptRequestForecast ?? null,
      chapters: options.chapters ?? [],
      descriptionHtml: options.descriptionHtml ?? null,
      descriptionText: options.descriptionText ?? null,
      onRequestTranscript: options.onRequestTranscript ?? vi.fn(),
      fragments,
      activeFragment,
      renderedHtml: "<p>active transcript html</p>",
      contentRef,
      onSegmentSelect: (fragment: TranscriptFragment) => {
        setActiveId(fragment.id);
        onSegmentSelect(fragment);
      },
      onContentClick: vi.fn(),
    } as TranscriptMediaPaneProps;

    return <TranscriptMediaPane {...props} />;
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

  it("renders play-next/add-to-queue actions and delegates queue intent to the player", async () => {
    const user = userEvent.setup();
    renderStatefulPodcastPane();

    expect(screen.getByRole("button", { name: /play next/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /add to queue/i })).toBeVisible();

    await user.click(screen.getByRole("button", { name: /play next/i }));
    await user.click(screen.getByRole("button", { name: /add to queue/i }));

    expect(mockAddToQueue).toHaveBeenNthCalledWith(1, "media-podcast-1", "next");
    expect(mockAddToQueue).toHaveBeenNthCalledWith(2, "media-podcast-1", "last");
  });

  it("renders the playback panel before transcript-state controls", () => {
    renderStatefulPodcastPane({
      canRead: false,
      processingStatus: "pending",
      fragments: [],
      transcriptState: "not_requested",
      transcriptCoverage: "none",
    });

    const playbackPanel = screen.getByText("Playback is controlled in the global player footer.");
    const transcriptStateUi = screen.getByText("Transcript has not been requested yet.");
    expect(
      playbackPanel.compareDocumentPosition(transcriptStateUi) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("renders the playback panel before transcript content", () => {
    renderStatefulPodcastPane({
      canRead: true,
      fragments: FRAGMENTS,
      chapters: PODCAST_CHAPTERS,
    });

    const playbackPanel = screen.getByText("Playback is controlled in the global player footer.");
    const transcriptContent = screen.getByRole("button", { name: /intro segment/i });
    expect(
      playbackPanel.compareDocumentPosition(transcriptContent) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("shows explicit on-demand transcription controls with budget forecast", async () => {
    const user = userEvent.setup();
    const onRequestTranscript = vi.fn();
    renderStatefulPodcastPane({
      canRead: false,
      processingStatus: "pending",
      fragments: [],
      transcriptState: "not_requested",
      transcriptCoverage: "none",
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

  it("warns when readable transcript coverage is partial", () => {
    renderStatefulPodcastPane({
      canRead: true,
      processingStatus: "ready_for_reading",
      transcriptState: "partial",
      transcriptCoverage: "partial",
      fragments: FRAGMENTS,
    });

    expect(
      screen.getByText("Transcript is partial; search and highlights may miss sections.")
    ).toBeVisible();
  });

  it("renders chapter list with links/images and seeks via chapter click", async () => {
    const user = userEvent.setup();
    renderStatefulPodcastPane({
      canRead: true,
      fragments: FRAGMENTS,
      chapters: PODCAST_CHAPTERS,
    });

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

  it("highlights active chapter from playback time and renders inline chapter headings", () => {
    mockCurrentTimeSeconds = 360;
    renderStatefulPodcastPane({
      canRead: true,
      fragments: FRAGMENTS,
      chapters: PODCAST_CHAPTERS,
    });

    expect(
      screen.getByRole("button", { name: "Jump to chapter 2: Deep Dive" })
    ).toHaveAttribute("aria-current", "true");
    expect(screen.getByText("Chapter 1: Intro")).toBeVisible();
    expect(screen.getByText("Chapter 2: Deep Dive")).toBeVisible();
  });

  it("renders show notes html and timestamp links seek active podcast playback", async () => {
    const user = userEvent.setup();
    renderStatefulPodcastPane({
      canRead: true,
      fragments: FRAGMENTS,
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

  it("renders active transcript html through the shared reader surface", () => {
    renderStatefulPodcastPane({
      canRead: true,
      fragments: FRAGMENTS,
      chapters: [],
    });

    expect(mockReaderContentArea).toHaveBeenCalledTimes(1);
    expect(screen.getByText("active transcript html")).toBeVisible();
  });

  it("falls back to plain text show notes when html is absent", () => {
    renderStatefulPodcastPane({
      canRead: true,
      fragments: FRAGMENTS,
      chapters: [],
      descriptionHtml: null,
      descriptionText: "line one\nline two",
    });

    expect(screen.getByRole("heading", { name: "Show Notes" })).toBeVisible();
    expect(screen.getByText("line one")).toBeVisible();
    expect(screen.getByText("line two")).toBeVisible();
  });

  it("omits chapter UI when episode has no chapters", () => {
    renderStatefulPodcastPane({
      canRead: true,
      fragments: FRAGMENTS,
      chapters: [],
    });

    expect(screen.queryByRole("heading", { name: "Chapters" })).not.toBeInTheDocument();
    expect(screen.queryByText("Chapter 1: Intro")).not.toBeInTheDocument();
  });
});

describe("TranscriptMediaPane transcript states", () => {
  it("renders queued provisioning state", () => {
    renderStatefulPodcastPane({
      canRead: false,
      transcriptState: "queued",
      transcriptCoverage: "none",
      processingStatus: "extracting",
      fragments: [],
    });

    expect(screen.getByText("Transcript request queued.")).toBeVisible();
    expect(screen.getByText("Status: extracting")).toBeVisible();
  });

  it("renders running provisioning state", () => {
    renderStatefulPodcastPane({
      canRead: false,
      transcriptState: "running",
      transcriptCoverage: "none",
      processingStatus: "extracting",
      fragments: [],
    });

    expect(screen.getByText("Transcript transcription is currently running.")).toBeVisible();
    expect(screen.getByText("Status: extracting")).toBeVisible();
  });

  it("renders failed_provider state with retry CTA", () => {
    renderStatefulPodcastPane({
      canRead: false,
      transcriptState: "failed_provider",
      transcriptCoverage: "none",
      processingStatus: "failed",
      fragments: [],
    });

    expect(screen.getByText("Previous transcription failed. You can retry on demand.")).toBeVisible();
    expect(screen.getByRole("button", { name: /transcribe this episode/i })).toBeEnabled();
  });

  it("renders failed_quota state with disabled CTA when forecast exceeds quota", () => {
    renderStatefulPodcastPane({
      canRead: false,
      transcriptState: "failed_quota",
      transcriptCoverage: "none",
      processingStatus: "failed",
      fragments: [],
      transcriptRequestForecast: {
        requiredMinutes: 4,
        remainingMinutes: 1,
        fitsBudget: false,
      },
    });

    expect(screen.getByText("Monthly transcription quota was exceeded for this episode.")).toBeVisible();
    expect(screen.getByText("Not enough monthly transcription quota for this request.")).toBeVisible();
    expect(screen.getByRole("button", { name: /transcribe this episode/i })).toBeDisabled();
  });

  it("renders unavailable state", () => {
    renderStatefulPodcastPane({
      canRead: false,
      transcriptState: "unavailable",
      transcriptCoverage: "none",
      processingStatus: "failed",
      fragments: [],
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

    renderStatefulPodcastPane({
      canRead: false,
      transcriptState: "not_requested",
      transcriptCoverage: "none",
      processingStatus: "pending",
      fragments: [],
    });

    expect(
      screen.getByText("Transcription is included with AI Plus and AI Pro.")
    ).toBeVisible();
    expect(screen.getByText("Current plan: Plus.")).toBeVisible();
    expect(
      screen.getByText("Upgrade in Settings, then come back here to request this transcript.")
    ).toBeVisible();
    expect(screen.queryByText(/Billing is temporarily unavailable/i)).not.toBeInTheDocument();
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

    renderStatefulPodcastPane({
      canRead: false,
      transcriptState: "not_requested",
      transcriptCoverage: "none",
      processingStatus: "pending",
      fragments: [],
    });

    expect(
      screen.getByText(
        "Billing is temporarily unavailable, so plan upgrades are unavailable right now."
      )
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /transcribe this episode/i })).not.toBeInTheDocument();
  });
});
