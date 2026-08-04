import { render, screen } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import "@/app/globals.css";
import { withRenderEnvironment } from "@/__tests__/helpers/renderEnvironment";
import type { ConversationMessage } from "@/lib/conversations/types";
import AssistantMessage from "./AssistantMessage";

// Risk: the Regenerate action is a completed-answer capability, distinct from
// failed-turn Run again (spec §5.4, AC-9). Oracle: `can_regenerate` gates the
// control and the click carries the exact source message id.

function completedAnswer(
  overrides: Partial<ConversationMessage>,
): ConversationMessage {
  return {
    id: "assistant-1",
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

describe("AssistantMessage regenerate action", () => {
  it("exposes Regenerate for an eligible completed answer and reruns its own id", async () => {
    const onRegenerate = vi.fn();
    render(
      withRenderEnvironment(
        <AssistantMessage
          message={completedAnswer({ can_regenerate: true })}
          messageOrdinal={1}
          forkOptions={[]}
          onRegenerateAssistantResponse={onRegenerate}
          timestampLabel="Aug 3"
        />,
      ),
    );
    const button = await screen.findByRole("button", {
      name: "Regenerate this answer",
    });
    await userEvent.click(button);
    expect(onRegenerate).toHaveBeenCalledWith("assistant-1");
  });

  it("hides Regenerate when the completed answer is not eligible", () => {
    render(
      withRenderEnvironment(
        <AssistantMessage
          message={completedAnswer({ can_regenerate: false })}
          messageOrdinal={1}
          forkOptions={[]}
          onRegenerateAssistantResponse={vi.fn()}
          timestampLabel="Aug 3"
        />,
      ),
    );
    expect(
      screen.queryByRole("button", { name: "Regenerate this answer" }),
    ).toBeNull();
  });
});
