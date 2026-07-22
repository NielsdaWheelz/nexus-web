import type { ComponentProps } from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import EpisodeControls from "./EpisodeControls";

type Props = ComponentProps<typeof EpisodeControls>;

function episode(transcriptState: Props["episode"]["transcript_state"]) {
  return {
    id: "episode-1",
    title: "Entitled episode",
    description_text: null,
    transcript_state: transcriptState,
  } as Props["episode"];
}

function transcriptController() {
  return {
    transcriptReasonByMediaId: {},
    transcriptRequestForecastByMediaId: {},
    requestingTranscriptMediaIds: { ids: new Set<string>() },
    expandedTranscriptMediaIds: { ids: new Set(["episode-1"]) },
    setTranscriptReasonByMediaId: vi.fn(),
    handleRequestTranscript: vi.fn(async () => undefined),
  } satisfies Props["transcript"];
}

describe("EpisodeControls transcript capability", () => {
  it("removes transcript request controls when entitlement is absent", () => {
    const transcript = transcriptController();
    const { rerender } = render(
      <EpisodeControls
        episode={episode("not_requested")}
        showNotesExpanded={false}
        transcript={transcript}
        transcriptionAllowed
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Submit transcript request for Entitled episode",
      }),
    ).toBeVisible();

    rerender(
      <EpisodeControls
        episode={episode("not_requested")}
        showNotesExpanded={false}
        transcript={transcript}
        transcriptionAllowed={false}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "Submit transcript request for Entitled episode",
      }),
    ).toBeNull();
  });

  it("keeps in-flight provisioning status visible without entitlement", () => {
    render(
      <EpisodeControls
        episode={episode("queued")}
        showNotesExpanded={false}
        transcript={transcriptController()}
        transcriptionAllowed={false}
      />,
    );

    expect(screen.getByText("Transcript request in progress")).toBeVisible();
  });
});
