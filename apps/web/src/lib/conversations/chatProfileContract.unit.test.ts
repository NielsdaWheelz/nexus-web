import { describe, expect, it } from "vitest";
import { decodeLlmProfilesResponse } from "./chatProfileContract";
import { isChatProfileSelection } from "./chatProfileSelection";

function catalog() {
  return {
    data: {
      default_profile_id: "balanced",
      profiles: [
        {
          id: "fast",
          label: "Fast",
          description: "Quick everyday responses.",
          model_label: "Luna",
          effort_label: "Low",
        },
        {
          id: "balanced",
          label: "Balanced",
          description: "Strong general reasoning.",
          model_label: "Terra",
          effort_label: "Medium",
        },
        {
          id: "deep",
          label: "Deep",
          description: "Deeper reasoning for hard problems.",
          model_label: "Sol",
          effort_label: "High",
        },
      ],
    },
  };
}

describe("LLM profile catalog wire contract", () => {
  it("accepts only the ordered three-row catalog with Balanced as default", () => {
    expect(decodeLlmProfilesResponse(catalog())).toEqual(catalog().data);
  });

  it("rejects retired provider and reasoning selector fields", () => {
    const candidate = catalog() as unknown as Record<string, unknown>;
    const data = candidate.data as { profiles: Array<Record<string, unknown>> };
    data.profiles[0].provider_label = "Legacy provider";
    data.profiles[0].reasoning_options = [];

    expect(() => decodeLlmProfilesResponse(candidate)).toThrow(
      "must contain exactly",
    );
  });

  it.each([
    ["wrong default", (value: ReturnType<typeof catalog>) => {
      value.data.default_profile_id = "fast";
    }],
    ["wrong order", (value: ReturnType<typeof catalog>) => {
      value.data.profiles.reverse();
    }],
    ["extra row", (value: ReturnType<typeof catalog>) => {
      value.data.profiles.push(value.data.profiles[0]);
    }],
    ["retired id", (value: ReturnType<typeof catalog>) => {
      value.data.profiles[0].id = "claude";
    }],
  ])("rejects a catalog with %s", (_label, mutate) => {
    const candidate = catalog();
    mutate(candidate);
    expect(() => decodeLlmProfilesResponse(candidate)).toThrow();
  });

  it("keeps persisted draft selection to one current profile id", () => {
    expect(isChatProfileSelection({ profileId: "deep" })).toBe(true);
    expect(isChatProfileSelection({ profileId: "claude" })).toBe(false);
    expect(
      isChatProfileSelection({ profileId: "deep", reasoningOptionId: "high" }),
    ).toBe(false);
  });
});
