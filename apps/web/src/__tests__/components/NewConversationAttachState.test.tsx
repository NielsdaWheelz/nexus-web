import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import NewConversationPage from "@/app/(authenticated)/conversations/new/page";
import ConversationNewPaneBody from "@/app/(authenticated)/conversations/new/ConversationNewPaneBody";
import { PaneRuntimeProvider } from "@/lib/panes/paneRuntime";

const hydrateContextItemsMock = vi.hoisted(() => vi.fn(async (items: unknown[]) => items));

vi.mock("@/lib/conversations/hydrateContextItems", () => ({
  hydrateContextItems: hydrateContextItemsMock,
}));

vi.mock("@/components/ChatComposer", () => ({
  default: (props: {
    attachedContexts?: { preview?: string }[];
    onConversationCreated?: (conversationId: string) => void;
    onMessageSent?: () => void;
  }) => (
    <div>
      <button
        type="button"
        onClick={() => {
          props.onConversationCreated?.("conv-created");
          props.onMessageSent?.();
        }}
      >
        Send mock message
      </button>
      <div data-testid="composer-attached-count">{props.attachedContexts?.length ?? 0}</div>
      {props.attachedContexts?.map((item, index) => (
        <div key={`attached-${index}`}>{item.preview ?? ""}</div>
      ))}
    </div>
  ),
}));

function renderInPaneRuntime(
  body: React.ReactNode,
  href: string,
  onReplacePane: (paneId: string, href: string) => void = () => {}
) {
  return render(
    <PaneRuntimeProvider
      paneId="pane-conversation-new"
      href={href}
      routeId="conversationNew"
      resourceRef={null}
      pathParams={{}}
      onNavigatePane={() => {}}
      onReplacePane={onReplacePane}
      onOpenInNewPane={() => {}}
    >
      {body}
    </PaneRuntimeProvider>
  );
}

function runSharedNewConversationAttachContractTests(
  name: string,
  createBody: () => React.ReactNode
) {
  describe(name, () => {
    beforeEach(() => {
      hydrateContextItemsMock.mockClear();
    });

    it("prepopulates from attach params and clears attach params after send", async () => {
      const user = userEvent.setup();
      const onReplacePane = vi.fn();
      renderInPaneRuntime(
        createBody(),
        "/conversations/new?foo=bar&attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=quoted%20line",
        onReplacePane
      );

      await screen.findByTestId("composer-attached-count");
      expect(screen.getByTestId("composer-attached-count")).toHaveTextContent("1");

      await user.click(screen.getByRole("button", { name: "Send mock message" }));

      expect(onReplacePane).toHaveBeenCalledWith(
        "pane-conversation-new",
        "/conversations/conv-created?foo=bar"
      );
      expect(screen.getByTestId("composer-attached-count")).toHaveTextContent("0");
    });

    it("does not rehydrate unchanged attach params on rerender", async () => {
      const { rerender } = renderInPaneRuntime(
        createBody(),
        "/conversations/new?attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=quoted%20line"
      );

      await screen.findByTestId("composer-attached-count");
      expect(hydrateContextItemsMock).toHaveBeenCalledTimes(1);

      rerender(
        <PaneRuntimeProvider
          paneId="pane-conversation-new"
          href="/conversations/new?attach_type=highlight&attach_id=11111111-1111-4111-8111-111111111111&attach_preview=quoted%20line"
          routeId="conversationNew"
          resourceRef={null}
          pathParams={{}}
          onNavigatePane={() => {}}
          onReplacePane={() => {}}
          onOpenInNewPane={() => {}}
        >
          {createBody()}
        </PaneRuntimeProvider>
      );

      await waitFor(() => {
        expect(hydrateContextItemsMock).toHaveBeenCalledTimes(1);
      });
    });
  });
}

runSharedNewConversationAttachContractTests("NewConversationPage", () => <NewConversationPage />);
runSharedNewConversationAttachContractTests("ConversationNewPaneBody", () => (
  <ConversationNewPaneBody />
));
