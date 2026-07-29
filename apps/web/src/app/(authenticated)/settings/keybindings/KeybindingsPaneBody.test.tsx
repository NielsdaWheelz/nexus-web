import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import {
  PaneReturnMementoProvider,
  PaneReturnVisitScope,
} from "@/lib/workspace/paneReturnMemento";
import { assumePaneVisitId } from "@/lib/workspace/schema";
import KeybindingsPaneBody from "./KeybindingsPaneBody";

const TEST_VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");

describe("KeybindingsPaneBody", () => {
  it("renders Nexus, canonical destinations, and the Today action", () => {
    render(
      <PaneReturnMementoProvider>
        <PaneReturnVisitScope visitId={TEST_VISIT_ID} routeKey="settings:/settings/keybindings">
          <KeybindingsProvider>
            <KeybindingsPaneBody />
          </KeybindingsProvider>
        </PaneReturnVisitScope>
      </PaneReturnMementoProvider>,
    );
    expect(screen.getByText("Open Nexus")).toBeInTheDocument();
    expect(screen.getByText("Go to Lectern")).toBeInTheDocument();
    expect(screen.getByText("Go to Stats")).toBeInTheDocument();
    expect(screen.getByText("Go to Atlas")).toBeInTheDocument();
    expect(screen.getByText("Go to Today")).toBeInTheDocument();
  });
});
