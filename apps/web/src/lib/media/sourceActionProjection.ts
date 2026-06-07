import {
  isFailedSourceIngest,
  type MediaActionCapabilities,
  type SourceActionResult,
} from "@/lib/media/ingestionClient";

type SourceActionKind = "retry" | "refresh";

type SourceActionSeverity = "success" | "warning";

export interface SourceActionProjection {
  processingStatus: SourceActionResult["processingStatus"];
  sourceFailed: boolean;
  resetRefreshSource: boolean;
  capabilityPatch: MediaActionCapabilities;
  feedback: {
    severity: SourceActionSeverity;
    title: string;
  };
}

export function projectSourceActionResult(
  result: SourceActionResult,
  {
    action,
    successTitle,
    failedTitle = "Source request failed after it was saved.",
  }: {
    action: SourceActionKind;
    successTitle: string;
    failedTitle?: string;
  },
): SourceActionProjection {
  const sourceFailed = isFailedSourceIngest(result);
  return {
    processingStatus: result.processingStatus,
    sourceFailed,
    resetRefreshSource: action === "refresh",
    capabilityPatch: result.capabilities,
    feedback: {
      severity: sourceFailed ? "warning" : "success",
      title: sourceFailed ? failedTitle : successTitle,
    },
  };
}
