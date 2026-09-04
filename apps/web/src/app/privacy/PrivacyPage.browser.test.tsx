import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import "@/app/globals.css";
import PrivacyPage from "./page";

it("discloses the Codex and configurable Provider API processor routes", () => {
  render(<PrivacyPage />);

  const article = screen.getByRole("article");
  expect(article).toHaveTextContent("Last updated September 1, 2026.");
  expect(article).toHaveTextContent(
    "Background generation and Codex Personal Chat use the operator-managed ChatGPT/Codex subscription and OpenAI Codex.",
  );
  expect(article).toHaveTextContent(
    "If you select a configured Provider API route in Chat, Nexus instead uses the operator-managed API credential for that provider.",
  );
  for (const processor of [
    "OpenAI",
    "Anthropic",
    "Google",
    "Moonshot AI",
    "DeepSeek",
    "xAI",
    "OpenRouter",
  ]) {
    expect(
      article,
      `privacy disclosure is missing configured processor ${processor}`,
    ).toHaveTextContent(processor);
  }
  expect(article).toHaveTextContent(
    "OpenRouter also uses the pinned upstream provider disclosed in Chat.",
  );
  expect(article).toHaveTextContent(
    "Before dispatch, Chat shows the selected route's processor chain, retention, training, and billing disclosures.",
  );
  expect(article).not.toHaveTextContent(
    "the content submitted to those features is processed by OpenAI through the operator-managed ChatGPT/Codex subscription",
  );
});
