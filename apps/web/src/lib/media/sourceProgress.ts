import {
  expectExactRecord,
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
      run_count: number;
      updated_at: string;
    }
  | {
      kind: "Counted";
      stage: "Extract";
      completed: number;
      total: number;
      unit: "Page" | "Chapter";
      run_count: number;
      updated_at: string;
    };

export function decodeMediaSourceProgress(raw: unknown): MediaSourceProgress {
  const name = "MediaSourceProgress";
  const carrier = expectRecord(raw, name);
  const kind = expectString(carrier.kind, `${name}.kind`);
  if (kind === "Stage") {
    const value = expectExactRecord(
      raw,
      ["kind", "stage", "run_count", "updated_at"],
      name,
    );
    return {
      kind,
      stage: expectOneOf(
        value.stage,
        ["Validate", "Extract", "Finalize"] as const,
        `${name}.stage`,
      ),
      run_count: expectNonnegativeInteger(
        value.run_count,
        `${name}.run_count`,
      ),
      updated_at: expectIsoInstant(value.updated_at, `${name}.updated_at`),
    };
  }
  if (kind === "Counted") {
    const value = expectExactRecord(
      raw,
      [
        "kind",
        "stage",
        "completed",
        "total",
        "unit",
        "run_count",
        "updated_at",
      ],
      name,
    );
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
      run_count: expectNonnegativeInteger(
        value.run_count,
        `${name}.run_count`,
      ),
      updated_at: expectIsoInstant(value.updated_at, `${name}.updated_at`),
    };
  }
  throw new TypeError(`${name}.kind is invalid`);
}
