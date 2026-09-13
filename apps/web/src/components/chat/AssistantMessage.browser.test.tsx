import { useState, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import { FeedbackProvider } from "@/components/feedback/Feedback";
import { AuthenticatedAccountProvider } from "@/lib/account/authenticatedAccount";
import { ResourceActionRuntimeProvider } from "@/lib/actions/resourceActionRuntime";
import { KeybindingsProvider } from "@/lib/keybindingsProvider";
import { LecternProvider } from "@/lib/lectern/LecternProvider";
import { MobileChromeProvider } from "@/lib/workspace/mobileChrome";
import { OfflineMediaProvider } from "@/lib/offlineMedia/OfflineMediaProvider";
import { PaneReturnMementoProvider } from "@/lib/workspace/paneReturnMemento";
import { GlobalPlayerProvider } from "@/lib/player/globalPlayer";
import { ShareControllerProvider } from "@/lib/sharing/controller";
import { LibraryPlacementControllerProvider } from "@/lib/libraries/placementController";
import {
  ResourceActionOverlays,
  ResourceOverlaysProvider,
} from "@/lib/resources/resourceOverlaysController";
import { createDefaultWorkspaceState } from "@/lib/workspace/schema";
import type { WorkspacePrimaryMetrics } from "@/lib/workspace/paneSizing";
import { WorkspaceStoreProvider } from "@/lib/workspace/store";
import type { ConversationMessage } from "@/lib/conversations/types";
import { MessageRow } from "./MessageRow";

// Product oracle: the canonical Message snapshot is the sole applicability
// owner. The row owns execution only, so Regenerate must dispatch through the
// shared menu to the mounted Message owner with the exact canonical identity.

const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const MESSAGE_REF = `message:${MESSAGE_ID}`;
const CONVERSATION_HREF = `/conversations/${CONVERSATION_ID}`;
const RESOLVE_PATH = "/api/resource-items/action-snapshots/resolve";
const FACTS_REVISION = "1".repeat(64);

const workspacePrimaryMetrics: WorkspacePrimaryMetrics = {
  primaryMinWidthPx: 684,
  primaryDefaultWidthPx: 684,
};

function completedAnswer(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id: MESSAGE_ID,
    seq: 2,
    role: "assistant",
    message_document: {
      type: "message_document",
      blocks: [{ type: "text", format: "markdown", text: "An answer." }],
    },
    trust_trail: null,
    citations: [],
    status: "complete",
    can_rerun: false,
    can_regenerate: false,
    created_at: "2026-08-03T00:00:00Z",
    updated_at: "2026-08-03T00:00:00Z",
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function installSnapshot(regenerateApplicable: boolean): void {
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(
        request?.url ?? String(input),
        window.location.origin,
      );
      const method = init?.method ?? request?.method ?? "GET";
      if (url.pathname === RESOLVE_PATH && method === "POST") {
        const body =
          typeof init?.body === "string" ? JSON.parse(init.body) : null;
        const refs: string[] = Array.isArray(body?.refs) ? body.refs : [];
        return jsonResponse({
          data: {
            snapshots: refs.map((ref) => ({
              ref,
              activation: {
                resourceRef: ref,
                kind: "route",
                href: CONVERSATION_HREF,
                unresolvedReason: null,
              },
              missing: false,
              factsRevision: FACTS_REVISION,
              capabilities:
                ref === MESSAGE_REF && regenerateApplicable
                  ? [
                      {
                        kind: "RegenerateMessage",
                        availability: { kind: "Available" },
                      },
                    ]
                  : [],
            })),
          },
        });
      }
      if (url.pathname === "/api/lectern") {
        return jsonResponse({ data: { items: [] } });
      }
      return jsonResponse({ data: null });
    },
  );
}

function renderInRuntime(node: ReactNode) {
  return render(
    withRenderEnvironment(
      <AuthenticatedAccountProvider
        account={{ accountId: ACCOUNT_ID, calendarTimeZone: "UTC" }}
      >
        <MobileChromeProvider>
          <KeybindingsProvider>
            <FeedbackProvider>
              <PaneReturnMementoProvider>
                <WorkspaceStoreProvider
                  initialState={createDefaultWorkspaceState(
                    CONVERSATION_HREF,
                    workspacePrimaryMetrics,
                  )}
                  workspacePrimaryMetrics={workspacePrimaryMetrics}
                >
                  <LecternProvider>
                    <LibraryPlacementControllerProvider>
                      <ShareControllerProvider>
                        <OfflineMediaProvider
                          accountId={ACCOUNT_ID}
                          transport={null}
                        >
                          <ResourceOverlaysProvider>
                            <GlobalPlayerProvider>
                              <ResourceActionRuntimeProvider>
                                {node}
                                <ResourceActionOverlays />
                              </ResourceActionRuntimeProvider>
                            </GlobalPlayerProvider>
                          </ResourceOverlaysProvider>
                        </OfflineMediaProvider>
                      </ShareControllerProvider>
                    </LibraryPlacementControllerProvider>
                  </LecternProvider>
                </WorkspaceStoreProvider>
              </PaneReturnMementoProvider>
            </FeedbackProvider>
          </KeybindingsProvider>
        </MobileChromeProvider>
      </AuthenticatedAccountProvider>,
    ),
  );
}

function PendingToCompleteAnswer({
  onRegenerate,
}: {
  readonly onRegenerate: (messageId: string) => Promise<"Committed">;
}) {
  const [complete, setComplete] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setComplete(true)}>
        Complete run
      </button>
      <MessageRow
        message={completedAnswer({
          can_regenerate: false,
          status: complete ? "complete" : "pending",
        })}
        messageOrdinal={1}
        onRegenerateAssistantResponse={onRegenerate}
      />
    </>
  );
}

describe("Assistant Message canonical actions", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  afterEach(() => vi.unstubAllGlobals());

  it("dispatches canonical Regenerate to the mounted owner with the exact Message id", async () => {
    installSnapshot(true);
    const onRegenerate = vi.fn(async () => "Committed" as const);
    renderInRuntime(<PendingToCompleteAnswer onRegenerate={onRegenerate} />);

    expect(
      screen.queryByRole("button", { name: "Actions for this answer" }),
    ).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Complete run" }));

    const trigger = await screen.findByRole("button", {
      name: "Actions for this answer",
    });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole("menuitem", { name: "Regenerate" }));

    await waitFor(() => expect(onRegenerate).toHaveBeenCalledWith(MESSAGE_ID));
  });

  it("does not invent Regenerate from a stale local DTO", async () => {
    installSnapshot(false);
    renderInRuntime(
      <MessageRow
        message={completedAnswer({ can_regenerate: true })}
        messageOrdinal={1}
        onRegenerateAssistantResponse={vi.fn(async () => "Committed" as const)}
      />,
    );

    const trigger = await screen.findByRole("button", {
      name: "Actions for this answer",
    });
    await waitFor(() => expect(trigger).toHaveAttribute("aria-disabled", "true"));
    expect(screen.queryByRole("menuitem", { name: "Regenerate" })).toBeNull();
  });
});
