import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import Colophon from "./Colophon";

describe("Colophon (browser render)", () => {
  it("uppercases modelName via formatColophonModel (AC-5)", () => {
    render(
      <Colophon
        modelName="claude-sonnet-4-6"
        inputTokens={null}
        outputTokens={null}
        totalCostUsdMicros={null}
        sourceCount={0}
      />,
    );
    expect(screen.getByText(/CLAUDE-SONNET-4-6/)).toBeInTheDocument();
  });

  it("renders nothing when all data is null/zero (no segments)", () => {
    render(
      <Colophon
        modelName=""
        inputTokens={null}
        outputTokens={null}
        totalCostUsdMicros={null}
        sourceCount={0}
      />,
    );
    expect(screen.queryByLabelText("Generation provenance")).toBeNull();
  });

  it("formats tokens in the rendered text (AC-5)", () => {
    render(
      <Colophon
        modelName="claude-sonnet-4-6"
        inputTokens={3200}
        outputTokens={1100}
        totalCostUsdMicros={null}
        sourceCount={0}
      />,
    );
    expect(screen.getByText(/3\.2K IN \/ 1\.1K OUT/)).toBeInTheDocument();
  });

  it("renders cost as $X.XXX (AC-6)", () => {
    render(
      <Colophon
        modelName="claude-sonnet-4-6"
        inputTokens={null}
        outputTokens={null}
        totalCostUsdMicros={14_123}
        sourceCount={0}
      />,
    );
    expect(screen.getByText(/\$0\.014/)).toBeInTheDocument();
  });

  it("omits cost segment when totalCostUsdMicros is null (AC-6)", () => {
    render(
      <Colophon
        modelName="claude-sonnet-4-6"
        inputTokens={null}
        outputTokens={null}
        totalCostUsdMicros={null}
        sourceCount={3}
      />,
    );
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(screen.getByText(/3 SOURCES/)).toBeInTheDocument();
  });

  it("singular source count: 1 SOURCE", () => {
    render(
      <Colophon
        modelName="claude-sonnet-4-6"
        inputTokens={null}
        outputTokens={null}
        totalCostUsdMicros={null}
        sourceCount={1}
      />,
    );
    expect(screen.getByText(/1 SOURCE/)).toBeInTheDocument();
    expect(screen.queryByText(/1 SOURCES/)).toBeNull();
  });

  it("plural source count: 4 SOURCES", () => {
    render(
      <Colophon
        modelName="claude-sonnet-4-6"
        inputTokens={null}
        outputTokens={null}
        totalCostUsdMicros={null}
        sourceCount={4}
      />,
    );
    expect(screen.getByText(/4 SOURCES/)).toBeInTheDocument();
  });

  it("joins segments with · delimiter", () => {
    render(
      <Colophon
        modelName="claude-sonnet-4-6"
        inputTokens={1000}
        outputTokens={500}
        totalCostUsdMicros={14_000}
        sourceCount={2}
      />,
    );
    const text = screen.getByLabelText("Generation provenance").textContent ?? "";
    expect(text).toContain(" · ");
    expect(text).toContain("CLAUDE-SONNET-4-6");
    expect(text).toContain("$0.014");
    expect(text).toContain("2 SOURCES");
  });
});
