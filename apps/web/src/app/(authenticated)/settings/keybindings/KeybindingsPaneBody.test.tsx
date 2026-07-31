import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import KeybindingsPaneBody from "./KeybindingsPaneBody";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");

describe("KeybindingsPaneBody", () => {
  it("renders Nexus, Quick Note, pane Search, destinations, and Today", () => {
    render(
      <MobileChromeProvider>
        <PaneReturnMementoProvider>
          <PaneReturnVisitScope
            visitId={TEST_VISIT_ID}
            routeKey="settings:/settings/keybindings"
          >
            <KeybindingsProvider>
              <KeybindingsPaneBody />
            </KeybindingsProvider>
          </PaneReturnVisitScope>
        </PaneReturnMementoProvider>
      </MobileChromeProvider>,
    );
    expect(screen.getByText("Open Nexus")).toBeInTheDocument();
    expect(screen.getByText("Quick Note")).toBeInTheDocument();
    expect(screen.getByText("Search this pane")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+F")).toBeInTheDocument();
    expect(screen.getByText("Go to Lectern")).toBeInTheDocument();
    expect(screen.getByText("Go to Stats")).toBeInTheDocument();
    expect(screen.getByText("Go to Atlas")).toBeInTheDocument();
    expect(screen.getByText("Go to Today")).toBeInTheDocument();
  });
});
