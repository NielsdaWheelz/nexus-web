import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "vitest/browser";
import { describe, expect, it } from "vitest";
import type { ExpectedChatFailure } from "@/lib/conversations/types";
import ChatFailureCard from "./ChatFailureCard";

interface FailureCase {
  failure: ExpectedChatFailure;
  title: string;
  body: string;
}

// Independent product oracle from the cutover's closed six-code projection.
const FAILURE_CASES: readonly FailureCase[] = [
  {
    failure: { code: "cancelled", can_rerun: true },
    title: "Cancelled",
    body: "This response was cancelled.",
  },
  {
    failure: { code: "context_too_large", can_rerun: false },
    title: "Conversation too large",
    body: "This conversation has grown too large to process. Start a new conversation or branch from an earlier point.",
  },
  {
    failure: { code: "invalid_output", can_rerun: false },
    title: "Invalid response",
    body: "The assistant returned an invalid response. Please try again.",
  },
  {
    failure: { code: "incomplete", can_rerun: true },
    title: "Response incomplete",
    body: "The response ended before it was finished.",
  },
  {
    failure: { code: "assistant_unavailable", can_rerun: true },
    title: "Assistant unavailable",
    body: "The assistant is temporarily unavailable. Please try again shortly.",
  },
  {
    failure: { code: "operator_defect", can_rerun: false },
    title: "Something went wrong",
    body: "This response couldn't be completed. Please try again in a new message.",
  },
];

function FailureMatrix() {
  const [selectedCode, setSelectedCode] = useState("None");
  return (
    <>
      {FAILURE_CASES.map(({ failure }) => (
        <section key={failure.code} aria-label={failure.code}>
          <ChatFailureCard
            failure={failure}
            supportId={{ kind: "Absent" }}
            canRerun={failure.can_rerun}
            onRerun={() => setSelectedCode(failure.code)}
          />
        </section>
      ))}
      <output aria-label="Selected rerun">{selectedCode}</output>
    </>
  );
}

describe("Chat failure cards", () => {
  it("renders the closed six-code copy and only the three eligible rerun actions", async () => {
    render(<FailureMatrix />);

    expect(screen.getAllByRole("alert")).toHaveLength(6);
    for (const expected of FAILURE_CASES) {
      const card = within(
        screen.getByRole("region", { name: expected.failure.code }),
      );
      expect(card.getByText(expected.title)).toBeVisible();
      expect(card.getByText(expected.body)).toBeVisible();
      expect(card.queryAllByRole("button")).toHaveLength(
        expected.failure.can_rerun ? 1 : 0,
      );
      expect(card.queryByRole("button", { name: "Reconnect" })).toBeNull();
    }

    expect(screen.getAllByRole("button", { name: "Run again" })).toHaveLength(
      3,
    );
    for (const code of [
      "cancelled",
      "incomplete",
      "assistant_unavailable",
    ] as const) {
      const card = within(screen.getByRole("region", { name: code }));
      await userEvent.click(card.getByRole("button", { name: "Run again" }));
      expect(screen.getByRole("status", { name: "Selected rerun" })).toHaveTextContent(
        code,
      );
    }
  });
});
