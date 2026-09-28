import {
  expectIsoInstant,
  expectNonnegativeInteger,
  expectOneOf,
  expectRecord,
  expectString,
} from "@/lib/validation";

export type MediaSourceProgress =
  | {
      kind: "Stage";
      stage: "Validate" | "Extract" | "Finalize";
      updated_at: string;
    }
  | {
      kind: "Counted";
      stage: "Extract";
      completed: number;
      total: number;
      unit: "Page" | "Chapter";
      updated_at: string;
    };

export function decodeMediaSourceProgress(raw: unknown): MediaSourceProgress {
  const name = "MediaSourceProgress";
  const value = expectRecord(raw, name);
  const kind = expectString(value.kind, `${name}.kind`);
  if (kind === "Stage") {
    return {
      kind,
      stage: expectOneOf(
        value.stage,
        ["Validate", "Extract", "Finalize"] as const,
        `${name}.stage`,
      ),
      updated_at: expectIsoInstant(value.updated_at, `${name}.updated_at`),
    };
  }
  if (kind === "Counted") {
    const total = expectNonnegativeInteger(value.total, `${name}.total`);
    if (total === 0) {
      throw new TypeError(`${name}.total must be positive`);
    }
    return {
      kind,
      stage: expectOneOf(value.stage, ["Extract"] as const, `${name}.stage`),
      completed: expectNonnegativeInteger(
        value.completed,
        `${name}.completed`,
      ),
      total,
      unit: expectOneOf(
        value.unit,
        ["Page", "Chapter"] as const,
        `${name}.unit`,
      ),
      updated_at: expectIsoInstant(value.updated_at, `${name}.updated_at`),
    };
  }
  throw new TypeError(`${name}.kind is invalid`);
}
