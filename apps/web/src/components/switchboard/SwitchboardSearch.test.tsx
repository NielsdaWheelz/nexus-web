import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type {
  NexusAction,
  NexusEntry,
  NexusEntryKey,
  NexusGroup,
  NexusProjection,
} from "@/lib/nexus/model";
import { nexusEntryKeyValue } from "@/lib/nexus/model";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import NexusButton from "./NexusButton";
import SwitchboardSearch, {
  type MobileNexusActionsRequest,
} from "./SwitchboardSearch";

function action(
  id: string,
  label: string,
  target: NexusAction["availability"] = {
    kind: "Available",
    target: { kind: "InternalHref", href: `/${id}` },
  },
): NexusAction {
  return {
    id,
    label,
    icon: Search,
    activation: { kind: "Standard" },
    availability: target,
  };
}

function entry(
  key: NexusEntryKey,
  label: string,
  options: {
    secondaryActions?: readonly NexusAction[];
    availability?: NexusAction["availability"];
    shortcutHint?: string;
  } = {},
): NexusEntry {
  return {
    key,
    historySource: "Static",
    label,
    icon: Search,
    primaryAction: action(
      `open-${nexusEntryKeyValue(key)}`,
      label,
      options.availability,
    ),
    secondaryActions: options.secondaryActions ?? [],
    ...(options.shortcutHint ? { shortcutHint: options.shortcutHint } : {}),
    rank: { tier: "Exact", score: 1, frecency: 0 },
  };
}

const openEntry = entry(
  { kind: "Pane", paneId: "pane-1" },
  "Open project",
  {
    secondaryActions: [
      action("close-project", "Close project", {
        kind: "Available",
        target: { kind: "PaneClose", paneId: "pane-1" },
      }),
    ],
  },
);
const quickEntry = entry(
  { kind: "QuickAction", actionId: "Nexus.Quick.Note" },
  "Quick Note",
  { shortcutHint: "N" },
);

function projection(groups: readonly NexusGroup[]): NexusProjection {
  return {
    surface: "Mobile",
    groups,
    activeKey: groups[0]?.entries[0]?.key ?? null,
  };
}

const blankProjection = projection([
  { id: "Open", label: "Open", layout: "CompactRail", entries: [openEntry] },
  {
    id: "QuickActions",
    label: "Quick Actions",
    layout: "CompactRail",
    entries: [quickEntry],
  },
  { id: "Continue", label: "Continue", layout: "CompactRail", entries: [] },
  { id: "Recent", label: "Recent", layout: "CompactRail", entries: [] },
  { id: "Places", label: "Places", layout: "CompactRail", entries: [] },
]);

function Harness({
  initialProjection,
  initialQuery = "",
  startActive = true,
  useNexusButton = false,
  actionsRequest = null,
}: {
  initialProjection: NexusProjection;
  initialQuery?: string;
  startActive?: boolean;
  useNexusButton?: boolean;
  actionsRequest?: MobileNexusActionsRequest | null;
}) {
  const [active, setActive] = useState(startActive);
  const [query, setQuery] = useState(initialQuery);
  const [activeKey, setActiveKey] = useState(initialProjection.activeKey);
  const [activation, setActivation] = useState("");
  const [unavailable, setUnavailable] = useState("");
  const currentProjection = useMemo(
    () => ({ ...initialProjection, activeKey }),
    [activeKey, initialProjection],
  );
  return (
    <>
      {useNexusButton ? (
        <NexusButton
          paneCount={1}
          switchboardOpen={active}
          onOpen={() => setActive(true)}
        />
      ) : (
        <button type="button" onClick={() => setActive(true)}>
          Open Nexus
        </button>
      )}
      <output aria-label="Active entry">
        {activeKey ? nexusEntryKeyValue(activeKey) : "none"}
      </output>
      <output aria-label="Activation">{activation}</output>
      <SwitchboardSearch
        active={active}
        focusKey={active ? "open" : "closed"}
        query={query}
        projection={currentProjection}
        accountMenu={<button type="button">Account</button>}
        failures={new Set()}
        busy={false}
        pending={false}
        announcement={unavailable}
        actionsRequest={actionsRequest}
        onDone={() => setActive(false)}
        onQuery={setQuery}
        onActive={setActiveKey}
        onActivate={(selected, targetActivation) =>
          setActivation(
            `${selected.label}:${targetActivation.disposition.kind}:${targetActivation.modality}`,
          )
        }
        onEntryActions={(selected) =>
          setActivation(`Actions:${selected.label}`)
        }
        onEscapeRoot={() => setActivation("Escape")}
        onUnavailable={setUnavailable}
        onRetry={() => undefined}
      />
    </>
  );
}

describe("mobile Nexus Root projection", () => {
  it("focuses the exact search field in the opening event flush and renders blank rails in owner order", () => {
    render(
      <MobileViewportProvider>
        <MobileChromeProvider>
          <Harness
            initialProjection={blankProjection}
            startActive={false}
            useNexusButton
          />
        </MobileChromeProvider>
      </MobileViewportProvider>,
    );
    const search = screen.getByRole("searchbox", { name: "Find anything…" });
    expect(search).not.toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: /Open Nexus/ }));

    expect(search).toHaveFocus();
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Open", "Quick Actions", "Continue", "Recent", "Places"]);
    expect(
      within(screen.getByRole("region", { name: "Open" })).getByRole(
        "button",
        { name: "Open project" },
      ),
    ).toBeVisible();
  });

  it("pins query actions before the one Results flow", () => {
    const ask = entry(
      { kind: "Continuation", id: "Ask" },
      "Ask Nexus about Project Ideas",
    );
    const result = entry(
      { kind: "Destination", destinationId: "notes" },
      "Project Ideas",
    );
    render(
      <Harness
        initialQuery="Project Ideas"
        initialProjection={projection([
          {
            id: "QueryActions",
            label: "Actions",
            layout: "PinnedBelowInput",
            entries: [ask],
          },
          {
            id: "Results",
            label: "Results",
            layout: "Flow",
            entries: [result],
          },
        ])}
      />,
    );

    const actions = screen.getByRole("region", { name: "Actions" });
    const results = screen.getByRole("region", { name: "Results" });
    expect(
      actions.compareDocumentPosition(results) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(screen.queryByRole("heading", { name: "Open" })).toBeNull();
  });

  it("keeps IME keys with composition, then activates the exact hardware-keyboard row", () => {
    render(<Harness initialProjection={blankProjection} />);
    const search = screen.getByRole("searchbox", { name: "Find anything…" });

    fireEvent.compositionStart(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByLabelText("Active entry")).toHaveTextContent(
      "Pane:pane-1",
    );

    fireEvent.compositionEnd(search);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(screen.getByLabelText("Active entry")).toHaveTextContent(
      "QuickAction:Nexus.Quick.Note",
    );
    fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
    expect(screen.getByLabelText("Activation")).toHaveTextContent(
      "Quick Note:Fork:Keyboard",
    );
  });

  it("announces an unavailable primary action and dispatches nothing", () => {
    const reason = "Open Today to finish the current embedded draft";
    const unavailable = entry(
      { kind: "Continuation", id: "AddToToday" },
      "Add “Project Ideas” to Today",
      { availability: { kind: "Unavailable", reason } },
    );
    render(
      <Harness
        initialQuery="Project Ideas"
        initialProjection={projection([
          {
            id: "QueryActions",
            label: "Actions",
            layout: "PinnedBelowInput",
            entries: [unavailable],
          },
          { id: "Results", label: "Results", layout: "Flow", entries: [] },
        ])}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `Add “Project Ideas” to Today. Unavailable. ${reason}`,
      }),
    );

    expect(screen.getByRole("status", { name: "Nexus status" })).toHaveTextContent(
      reason,
    );
    expect(screen.getByLabelText("Activation")).toBeEmptyDOMElement();
  });

  it("keeps secondary actions in the sibling ActionMenu and handles a snapshotted Actions request", async () => {
    const view = render(<Harness initialProjection={blankProjection} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Actions for Open project" }),
    );
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close project" }));
    expect(screen.getByLabelText("Activation")).toHaveTextContent(
      "Close project:Follow:Pointer",
    );

    const actionsTrigger = screen.getByRole("button", {
      name: "Actions for Open project",
    });
    fireEvent.keyDown(actionsTrigger, { key: "Enter" });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Close project" }),
      { detail: 0 },
    );
    expect(screen.getByLabelText("Activation")).toHaveTextContent(
      "Close project:Follow:Keyboard",
    );

    view.rerender(
      <Harness
        initialProjection={blankProjection}
        actionsRequest={{ requestId: 1, entry: openEntry }}
      />,
    );
    await waitFor(() =>
      expect(screen.getByLabelText("Activation")).toHaveTextContent(
        "Actions:Open project",
      ),
    );
  });
});
