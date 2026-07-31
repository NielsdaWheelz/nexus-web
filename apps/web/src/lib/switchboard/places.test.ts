import { describe, expect, it } from "vitest";
import { DESTINATION_REGISTRY } from "@/lib/navigation/destinations";
import { SWITCHBOARD_PLACES } from "./places";

describe("Switchboard Places", () => {
  it("projects the fixed seven identities from the destination registry", () => {
    expect(SWITCHBOARD_PLACES.map((place) => place.label)).toEqual([
      "Today",
      "Lectern",
      "Libraries",
      "Browse",
      "Podcasts",
      "Chats",
      "Notes",
    ]);
    for (const place of SWITCHBOARD_PLACES) {
      expect(place).toMatchObject(DESTINATION_REGISTRY[place.id]);
    }
  });
});
