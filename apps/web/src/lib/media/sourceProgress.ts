import type { Schema } from "@/lib/api/wire";

export type MediaSourceProgress =
  | Schema<"SourceStageProgress">
  | Schema<"SourceCountedProgress">;
