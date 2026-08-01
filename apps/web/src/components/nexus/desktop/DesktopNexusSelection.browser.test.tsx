import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import {
  nexusEntryKeyValue,
  type NexusAction,
  type NexusEntry,
  type NexusEntryKey,
  type NexusIcon,
} from "@/lib/nexus/model";
import DesktopNexus from "./DesktopNexus";
import { desktopNexusCellId } from "./DesktopNexusInput";
import type { DesktopNexusController } from "./types";

const FixtureIcon: NexusIcon = (props) => (
  <svg {...props} viewBox="0 0 10 10">
    <circle cx="5" cy="5" r="4" />
  </svg>
);

function action(id: string, label: string): NexusAction {
  return {
    id,
    label,
    icon: FixtureIcon,
    activation: { kind: "Standard" },
    availability: {
      kind: "Available",
      target: { kind: "InternalHref", href: `/${id}` },
    },
  };
}

function entry(paneId: string, label: string): NexusEntry {
  return {
    key: { kind: "Pane", paneId },
    historySource: "Workspace",
    label,
    typeLabel: "Page",
    icon: FixtureIcon,
    primaryAction: action("open", "Open"),
    secondaryActions: [action("share", "Share")],
    rank: { tier: "Exact", score: 1, frecency: 1 },
  };
}

it("keeps virtual selection stable under result reflow until the pointer moves", () => {
  const first = entry("reading-notes", "Reading notes");
  const second = entry("project-notes", "Project notes");

  function Scenario() {
    const [activeKey, setActiveKey] = useState<NexusEntryKey>(first.key);
    const controller: DesktopNexusController = {
      open: true,
      projection: {
        surface: "Desktop",
        groups: [
          {
            id: "Results",
            label: "Results",
            layout: "Flow",
            entries: [first, second],
          },
        ],
        activeKey,
      },
      query: "notes",
      failures: new Set(),
      busy: false,
      announcement: null,
      focusKey: "Root",
      nexusOpenShortcutLabel: "Ctrl+K",
      actionsRequest: null,
      setQuery: () => {},
      setActiveEntry: setActiveKey,
      activatePrimary: () => {},
      activateAction: () => {},
      retry: () => {},
      escape: () => {},
      shouldSuppressReturnFocusOnClose: () => false,
    };
    return <DesktopNexus controller={controller} />;
  }

  render(withRenderEnvironment(<Scenario />));
  const input = screen.getByRole("combobox", { name: "Find anything…" });
  const firstPrimaryId = desktopNexusCellId(first.key, "Primary");
  const secondPrimary = screen.getByRole("gridcell", {
    name: /^Project notes\./,
  });
  const secondActions = screen.getByRole("button", {
    name: "Actions for Project notes",
  });

  expect(input).toHaveAttribute("aria-activedescendant", firstPrimaryId);

  fireEvent.pointerEnter(secondPrimary);
  fireEvent.pointerEnter(secondActions);

  expect(
    input,
    `Stationary-pointer reflow moved selection away from ${nexusEntryKeyValue(first.key)}.`,
  ).toHaveAttribute("aria-activedescendant", firstPrimaryId);

  fireEvent.pointerMove(secondPrimary);
  expect(input).toHaveAttribute(
    "aria-activedescendant",
    desktopNexusCellId(second.key, "Primary"),
  );

  fireEvent.pointerMove(secondActions);
  expect(input).toHaveAttribute(
    "aria-activedescendant",
    desktopNexusCellId(second.key, "Actions"),
  );
});
