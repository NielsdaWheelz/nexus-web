import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FeedbackNotice } from "@/components/feedback/Feedback";
import PaneSection from "@/components/ui/PaneSection";
import PaneSurface from "@/components/ui/PaneSurface";
import { PaneLoadingState } from "@/components/workspace/PaneLoadingState";

describe("PaneSurface", () => {
  it("renders toolbar, state, content, and footer in order", () => {
    render(
      <PaneSurface
        toolbar={<button>Search</button>}
        state={
          <FeedbackNotice
            content={{ tone: "Info", title: "Ready" }}
            announcement="Polite"
          />
        }
        footer={<button>Load more</button>}
      >
        <p>Results</p>
      </PaneSurface>,
    );

    expect(
      screen.getByRole("button", { name: "Search" }).compareDocumentPosition(
        screen.getByRole("status"),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByRole("status").compareDocumentPosition(screen.getByText("Results")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByText("Results").compareDocumentPosition(
        screen.getByRole("button", { name: "Load more" }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders an empty state when there is no content", () => {
    render(
      <PaneSurface
        state={<PaneLoadingState label="Loading rows" announcement="Polite" />}
        empty={
          <FeedbackNotice
            content={{ tone: "Neutral", title: "No rows." }}
            announcement="None"
          />
        }
      />,
    );

    expect(screen.getByText("Loading rows")).toBeInTheDocument();
    expect(screen.getByText("No rows.")).toBeInTheDocument();
  });

  it("does not treat renderable falsy content as empty", () => {
    render(
      <PaneSurface
        empty={
          <FeedbackNotice
            content={{ tone: "Neutral", title: "No rows." }}
            announcement="None"
          />
        }
      >
        {0}
      </PaneSurface>,
    );

    expect(screen.getByText("0")).toBeInTheDocument();
    expect(screen.queryByText("No rows.")).toBeNull();
  });

  it("renders the opener unconditionally, alongside the empty state", () => {
    render(
      <PaneSurface
        opener={<div>Section opener</div>}
        empty={
          <FeedbackNotice
            content={{ tone: "Neutral", title: "No rows." }}
            announcement="None"
          />
        }
      />,
    );

    expect(screen.getByText("Section opener")).toBeInTheDocument();
    expect(screen.getByText("No rows.")).toBeInTheDocument();
  });

  it("treats an empty fragment as no content so the empty state survives", () => {
    render(
      <PaneSurface
        empty={
          <FeedbackNotice
            content={{ tone: "Neutral", title: "No rows." }}
            announcement="None"
          />
        }
      >
        <></>
      </PaneSurface>,
    );

    expect(screen.getByText("No rows.")).toBeInTheDocument();
  });
});

describe("PaneSection", () => {
  it("renders titled and untitled sections", () => {
    render(
      <>
        <PaneSection
          title="Theme"
          description="Choose the reading theme."
          actions={<button>Reset</button>}
        >
          <p>Theme controls</p>
        </PaneSection>
        <PaneSection>
          <p>Untitled body</p>
        </PaneSection>
      </>,
    );

    expect(screen.getByRole("heading", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByText("Choose the reading theme.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByText("Theme controls")).toBeInTheDocument();
    expect(screen.getByText("Untitled body")).toBeInTheDocument();
  });
});
