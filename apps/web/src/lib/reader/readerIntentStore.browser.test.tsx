import { expect, it } from "vitest";
import { ReaderIntentStore } from "./readerIntentStore";
import type { ReaderResumeState } from "./types";

const source = { kind: "Publication", reader_generation: 1 } as const;
function locator(page: number): ReaderResumeState {
  return { kind: "pdf", page, page_progression: null, zoom: null, position: null };
}

it("two recovery contexts retain one frozen attempt while newer movement survives its acknowledgment", async () => {
  const first = new ReaderIntentStore();
  const second = new ReaderIntentStore();
  const identity = { accountId: crypto.randomUUID(), writerId: crypto.randomUUID(), mediaId: crypto.randomUUID() };
  const baseline = { state: "Empty", revision: 0 } as const;
  await first.capture({ ...identity, sequence: 1, source, locator: locator(2), baseline });
  const frozen = await first.freeze(identity.accountId, identity.writerId);
  expect(frozen?.row.attempt?.locator).toEqual(locator(2));
  expect(frozen?.retained, "a first dispatch was reported as an already retained attempt").toBe(false);
  await second.capture({ ...identity, sequence: 2, source, locator: locator(3), baseline });
  const duplicate = await second.freeze(identity.accountId, identity.writerId);
  expect(duplicate?.row.attempt).toEqual(frozen?.row.attempt);
  expect(duplicate?.retained, "a duplicate dispatch was reported as a first dispatch").toBe(true);
  if (frozen === null) throw new Error("Missing captured intent");
  await first.acknowledge(frozen.row, { state: "Positioned", revision: 1, source, locator: locator(2) });
  const retained = await second.get(identity.accountId, identity.writerId);
  expect(retained?.desired.locator, "acknowledgment erased newer durable movement").toEqual(locator(3));
  expect(retained?.baseline.revision).toBe(1);
  expect(retained?.attempt).toBeNull();
  const next = await second.freeze(identity.accountId, identity.writerId);
  expect(next?.row.attempt?.baseRevision).toBe(1);
  expect(next?.retained).toBe(false);
  await first.acknowledge(frozen.row, { state: "Positioned", revision: 1, source, locator: locator(2) });
  expect(await second.get(identity.accountId, identity.writerId)).toEqual(next?.row);
});

it("a stale recovery choice cannot erase newer movement or acknowledge a rebased attempt", async () => {
  const store = new ReaderIntentStore();
  const identity = { accountId: crypto.randomUUID(), writerId: crypto.randomUUID(), mediaId: crypto.randomUUID() };
  const baseline = { state: "Empty", revision: 0 } as const;
  await store.capture({ ...identity, sequence: 1, source, locator: locator(2), baseline });
  const frozen = await store.freeze(identity.accountId, identity.writerId);
  if (frozen === null) throw new Error("Missing captured intent");
  const shown = frozen.row;
  const canonical = { state: "Positioned", revision: 1, source, locator: locator(7) } as const;
  expect(await store.resolve(shown, canonical, "Device")).toBe(true);
  const rebased = await store.freeze(identity.accountId, identity.writerId);
  expect(rebased?.row.attempt?.baseRevision).toBe(1);
  await store.acknowledge(shown, canonical);
  expect(await store.get(identity.accountId, identity.writerId)).toEqual(rebased?.row);
  await store.capture({ ...identity, sequence: 2, source, locator: locator(3), baseline: canonical });
  expect(await store.resolve(shown, canonical, "Canonical")).toBe(false);
  expect((await store.get(identity.accountId, identity.writerId))?.desired.locator).toEqual(locator(3));
});
