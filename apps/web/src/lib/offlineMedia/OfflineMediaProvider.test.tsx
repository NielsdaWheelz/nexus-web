import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "lucide-react";
import AccountMenu from "@/components/appnav/AccountMenu";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { MobileViewportProvider } from "@/lib/mobileViewport/MobileViewportProvider";
import { NAV_ACCOUNT } from "@/components/appnav/navModel";
import type { OfflineMediaCommand } from "./contract";
import {
  OfflineMediaProvider,
  useOfflineMediaCapability,
  useOfflineMediaStreamResolver,
} from "./OfflineMediaProvider";
import type { OfflineMediaTransport } from "./transport";

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

class HandshakeTransport implements OfflineMediaTransport {
  readonly commands: OfflineMediaCommand[] = [];
  stops = 0;
  private listener: ((message: unknown) => void) | null = null;

  constructor(
    private readonly connectOutcome:
      | Record<string, unknown>
      | null = {
      kind: "Connected",
      items: [],
      networkPolicy: "UnmeteredOnly",
    },
  ) {}

  start = (listener: (message: unknown) => void) => {
    this.listener = listener;
    return () => {
      this.stops += 1;
      this.listener = null;
    };
  };

  send = (command: OfflineMediaCommand) => {
    this.commands.push(command);
    if (command.kind === "Connect" && this.connectOutcome !== null) {
      queueMicrotask(() =>
        this.listener?.({
          requestId: command.requestId,
          protocolVersion: 1,
          outcome: this.connectOutcome,
        }),
      );
    }
    if (command.kind === "GetSnapshot") {
      queueMicrotask(() =>
        this.listener?.({
          requestId: command.requestId,
          protocolVersion: 1,
          outcome: {
            kind: "Snapshot",
            items: [],
            networkPolicy: "UnmeteredOnly",
          },
        }),
      );
    }
  };

  event(event: Record<string, unknown>): void {
    this.listener?.({ protocolVersion: 1, ...event });
  }
}

function Probe() {
  const capability = useOfflineMediaCapability();
  const resolveStreamUrl = useOfflineMediaStreamResolver();
  return (
    <>
      <p data-testid="offline-capability">{capability.kind}</p>
      <span>{resolveStreamUrl("media", "https://remote.test")}</span>
    </>
  );
}

function AccountProbe() {
  return (
    <AccountMenu
      settings={{ ...NAV_ACCOUNT, icon: Settings }}
      active={false}
      placement="below"
      align="start"
      renderTrigger={(props) => <button {...props}>Account</button>}
      onNavigate={() => "handled-source-focus"}
    />
  );
}

describe("OfflineMediaProvider", () => {
  it("treats a successful native handshake as capability truth", async () => {
    const transport = new HandshakeTransport();
    render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider accountId={ACCOUNT_ID} transport={transport}>
            <Probe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );

    expect(await screen.findByText("Ready")).toBeInTheDocument();
    expect(transport.commands[0]).toMatchObject({
      kind: "Connect",
      accountId: ACCOUNT_ID,
      protocolVersion: 1,
    });
  });

  it("stays unavailable without the injected capability", () => {
    render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider accountId={ACCOUNT_ID} transport={null}>
            <Probe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("https://remote.test")).toBeInTheDocument();
  });

  it("does not infer capability from a forged Android user agent", () => {
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36",
    );
    render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider accountId={ACCOUNT_ID}>
            <Probe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );

    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("starts a fresh fenced native session when the verified account changes", async () => {
    const firstTransport = new HandshakeTransport();
    const secondTransport = new HandshakeTransport();
    const { rerender } = render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider
            accountId={ACCOUNT_ID}
            transport={firstTransport}
          >
            <Probe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );
    expect(await screen.findByText("Ready")).toBeInTheDocument();

    rerender(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider
            accountId={OTHER_ACCOUNT_ID}
            transport={secondTransport}
          >
            <Probe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );

    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(secondTransport.commands[0]).toMatchObject({
        kind: "Connect",
        accountId: OTHER_ACCOUNT_ID,
      }),
    );
    expect(firstTransport.stops).toBe(1);
  });

  it("does not request a visibility snapshot until Connect succeeds", async () => {
    const transport = new HandshakeTransport(null);
    render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider accountId={ACCOUNT_ID} transport={transport}>
            <Probe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );
    expect(await screen.findByText("Connecting")).toBeInTheDocument();

    document.dispatchEvent(new Event("visibilitychange"));

    expect(transport.commands.map((command) => command.kind)).toEqual([
      "Connect",
    ]);
  });

  it("refreshes the snapshot only after a connected session becomes visible", async () => {
    const transport = new HandshakeTransport();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider accountId={ACCOUNT_ID} transport={transport}>
            <Probe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );
    expect(await screen.findByText("Ready")).toBeInTheDocument();

    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() =>
      expect(transport.commands.map((command) => command.kind)).toEqual([
        "Connect",
        "GetSnapshot",
      ]),
    );
  });

  it("stops the native port when Connect is rejected", async () => {
    const transport = new HandshakeTransport({
      kind: "Rejected",
      code: "AccountMismatch",
    });
    render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider accountId={ACCOUNT_ID} transport={transport}>
            <Probe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );

    await waitFor(() => expect(transport.stops).toBe(1));
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
  });

  it("shows Downloads in Account only after the native handshake", async () => {
    const transport = new HandshakeTransport();
    const user = userEvent.setup();
    render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider accountId={ACCOUNT_ID} transport={transport}>
            <AccountProbe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );
    await waitFor(() =>
      expect(transport.commands[0]?.kind).toBe("Connect"),
    );
    await user.click(screen.getByRole("button", { name: "Account" }));

    expect(
      await screen.findByRole("menuitem", { name: "Downloads" }),
    ).toBeInTheDocument();
  });

  it("owns one milestone-only polite live region", async () => {
    const transport = new HandshakeTransport({
      kind: "Connected",
      items: [
        {
          mediaId: ACCOUNT_ID,
          title: "Exact episode",
          state: {
            kind: "Present",
            value: { kind: "Queued", reason: "Capacity" },
          },
        },
      ],
      networkPolicy: "UnmeteredOnly",
    });
    render(
      <FeedbackProvider>
        <MobileViewportProvider>
          <OfflineMediaProvider accountId={ACCOUNT_ID} transport={transport}>
            <Probe />
          </OfflineMediaProvider>
        </MobileViewportProvider>
      </FeedbackProvider>,
    );
    expect(await screen.findByText("Ready")).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("");

    transport.event({
      kind: "StateChanged",
      mediaId: ACCOUNT_ID,
      state: {
        kind: "Present",
        value: {
          kind: "Downloading",
          bytesDownloaded: 47,
          totalBytes: { kind: "Present", value: 100 },
        },
      },
    });
    await waitFor(() =>
      expect(status).toHaveTextContent("Downloading Exact episode"),
    );

    transport.event({
      kind: "StateChanged",
      mediaId: ACCOUNT_ID,
      state: {
        kind: "Present",
        value: {
          kind: "Downloading",
          bytesDownloaded: 82,
          totalBytes: { kind: "Present", value: 100 },
        },
      },
    });
    await waitFor(() =>
      expect(screen.getAllByRole("status")).toHaveLength(1),
    );
    expect(status).toHaveTextContent("Downloading Exact episode");
    expect(status).not.toHaveTextContent(/%|82/);
  });
});
