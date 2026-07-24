import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { ReaderProvider } from "@/lib/reader/ReaderContext";
import { ReaderProfileSaveFeedback } from "@/lib/reader/ReaderProfileSaveFeedback";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";
import type { ReaderProfile } from "@/lib/reader/types";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import SettingsReaderPaneBody from "./SettingsReaderPaneBody";

const TEST_VISIT_ID = assumePaneVisitId(
  "00000000-0000-4000-8000-000000000001",
);

const BASE: ReaderProfile = {
  theme: "light",
  font_family: "serif",
  font_size_px: 16,
  line_height: 1.5,
  column_width_ch: 65,
  focus_mode: "off",
  hyphenation: "auto",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const fetchMock = vi.fn(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// The real presentation composition: global Feedback owner, reader capability,
// the global save-failure presenter, and the pane runtime driving `isActive`.
function Harness({ initiallyActive = true }: { initiallyActive?: boolean }) {
  const [isActive, setIsActive] = useState(initiallyActive);
  return (
    <PaneReturnMementoProvider>
      <FeedbackProvider>
        <ReaderProvider initialProfile={BASE}>
          <ReaderProfileSaveFeedback />
          <button onClick={() => setIsActive((active) => !active)}>
            toggle pane activity
          </button>
          <PaneRuntimeProvider
            paneId="pane-settings"
            visitId={TEST_VISIT_ID}
            isActive={isActive}
            href="/settings/reader"
            routeId="settingsReader"
            canGoBack={false}
            canGoForward={false}
            onGoBackPane={vi.fn()}
            onGoForwardPane={vi.fn()}
            onNavigatePane={vi.fn()}
            onReplacePane={vi.fn()}
            onOpenInNewPane={vi.fn()}
          >
            <SettingsReaderPaneBody />
          </PaneRuntimeProvider>
        </ReaderProvider>
      </FeedbackProvider>
    </PaneReturnMementoProvider>
  );
}

function failThenAckFetch(profile: ReaderProfile) {
  let failNext = true;
  return stubFetch(() => {
    if (failNext) {
      failNext = false;
      return Promise.resolve(
        jsonResponse({ error: { code: "E_INTERNAL", message: "boom", request_id: "req-7" } }, 500),
      );
    }
    return Promise.resolve(jsonResponse({ data: profile }));
  });
}

describe("SettingsReaderPaneBody", () => {
  // Unstub only after ALL tests: the runner's auto-cleanup unmounts each test's
  // tree first, so the provider teardown flush lands in that test's fetch stub
  // instead of the real network. Each test installs its own stub up front.
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("renders interactive controls immediately with no mount or save-time disabling", async () => {
    stubFetch(() => Promise.resolve(jsonResponse({ data: { ...BASE, theme: "dark" } })));
    render(<Harness />);

    const theme = screen.getByLabelText("Theme");
    expect(theme).toBeEnabled();

    fireEvent.change(theme, { target: { value: "dark" } });
    // Pending save: quiet polite status, controls still interactive.
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
    expect(theme).toBeEnabled();
    expect(screen.getByLabelText(/Font size/)).toBeEnabled();

    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("presents a failure inline while active, suppressing the global toast to one alert region", async () => {
    failThenAckFetch({ ...BASE, theme: "dark" });
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Reader settings didn’t save");
    expect(alert).toHaveTextContent("Nexus request ID: req-7");
    // Exactly one live failure presentation: the suppressed global toast
    // contributes no second alert region.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    // Failed controls stay interactive.
    expect(screen.getByLabelText("Theme")).toBeEnabled();

    // Inline Retry sends the merged patch and clears the presentation.
    fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  });

  it("moves the presentation to the global notice when the pane deactivates", async () => {
    failThenAckFetch({ ...BASE, theme: "dark" });
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });
    await screen.findByRole("alert");

    fireEvent.click(screen.getByRole("button", { name: "toggle pane activity" }));

    // Inactive Settings renders no inline live notice; the released lease
    // restores the retained global toast — still exactly one presentation.
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toHaveTextContent("Reader settings didn’t save");
    });
    // The global toast carries the Retry action.
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" }))
      .toBeInTheDocument();

    // Re-activating moves it back inline.
    fireEvent.click(screen.getByRole("button", { name: "toggle pane activity" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(1));
  });

  it("disables persistence controls without Retry on terminal Forbidden", async () => {
    stubFetch(() =>
      Promise.resolve(jsonResponse({ error: { code: "E_FORBIDDEN", message: "no" } }, 403)),
    );
    render(<Harness />);

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Reader settings can’t be changed");
    expect(within(alert).queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Theme")).toBeDisabled();
    expect(screen.getByLabelText(/Font size/)).toBeDisabled();
    // Desired pixels restored to acknowledged truth.
    expect(screen.getByLabelText("Theme")).toHaveValue("light");
  });
});
