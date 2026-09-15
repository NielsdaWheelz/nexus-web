import { Component, type ReactNode } from "react";
import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import {
  PaneRuntimeProvider,
  requirePaneRuntime,
  usePaneRuntime,
} from "./paneRuntime";
import { assumePaneVisitId } from "@/lib/workspace/schema";

const VISIT_ID = assumePaneVisitId("00000000-0000-4000-8000-000000000001");
const noop = () => undefined;

function RuntimeProbe() {
  const runtime = requirePaneRuntime(usePaneRuntime(), "RuntimeProbe");
  return <p>{runtime.resourceStatus}</p>;
}

class DefectBoundary extends Component<
  { children: ReactNode },
  { defect: boolean }
> {
  state = { defect: false };

  static getDerivedStateFromError(): { defect: boolean } {
    return { defect: true };
  }

  render() {
    return this.state.defect ? <p>pane-runtime-defect</p> : this.props.children;
  }
}

it("defects when ready resource status has no resource item", async () => {
  render(
    <DefectBoundary>
      <PaneRuntimeProvider
        paneId="pane-a"
        visitId={VISIT_ID}
        isActive
        href="/pages/11111111-1111-4111-8111-111111111111"
        routeId="page"
        resourceItem={null}
        resourceStatus="ready"
        canGoBack={false}
        canGoForward={false}
        onNavigatePane={noop}
        onReplacePane={noop}
        onActivateWorkspaceTarget={() => ({
          kind: "ActivatedExisting",
          paneId: "pane-a",
        })}
        onGoBackPane={noop}
        onGoForwardPane={noop}
      >
        <RuntimeProbe />
      </PaneRuntimeProvider>
    </DefectBoundary>,
  );

  expect(await screen.findByText("pane-runtime-defect")).toBeVisible();
});
