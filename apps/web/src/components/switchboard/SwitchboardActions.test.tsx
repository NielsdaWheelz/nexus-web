import { useState } from "react";
import { Circle } from "lucide-react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NexusAction, NexusEntry } from "@/lib/nexus/model";
import SwitchboardActions from "./SwitchboardActions";

const available: NexusAction = {
  id: "share",
  label: "Share",
  icon: Circle,
  activation: { kind: "Standard" },
  availability: {
    kind: "Available",
    target: { kind: "InternalHref", href: "/share" },
  },
};
const unavailable: NexusAction = {
  id: "append",
  label: "Add to Today",
  icon: Circle,
  activation: { kind: "DailyTextHandoff" },
  availability: {
    kind: "Unavailable",
    reason: "Today has an embedded draft",
  },
};
const entry: NexusEntry = {
  key: { kind: "Resource", occurrenceRef: "resource-1" },
  historySource: "Search",
  label: "Project Ideas",
  icon: Circle,
  primaryAction: available,
  secondaryActions: [available, unavailable],
  rank: { tier: "Exact", score: 1, frecency: 0 },
};

function Harness() {
  const [announcement, setAnnouncement] = useState("");
  const [activation, setActivation] = useState("");
  return (
    <>
      <output aria-label="Activation">{activation}</output>
      <SwitchboardActions
        entry={entry}
        onBack={() => undefined}
        unavailableAnnouncement={announcement}
        onUnavailable={setAnnouncement}
        onSelect={(action, targetActivation) =>
          setActivation(`${action.label}:${targetActivation.modality}`)
        }
      />
    </>
  );
}

describe("mobile Nexus entry actions", () => {
  it("keeps unavailable actions focusable, announces the reason, and dispatches nothing", () => {
    render(<Harness />);
    const button = screen.getByRole("button", {
      name: "Add to Today. Unavailable. Today has an embedded draft",
    });

    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).not.toBeDisabled();
    fireEvent.click(button);

    expect(screen.getByRole("status", { name: "Nexus status" })).toHaveTextContent(
      "Today has an embedded draft",
    );
    expect(screen.getByLabelText("Activation")).toBeEmptyDOMElement();
  });

  it("preserves keyboard modality for an available action", () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Share" }), {
      detail: 0,
    });

    expect(screen.getByLabelText("Activation")).toHaveTextContent(
      "Share:Keyboard",
    );
  });
});
