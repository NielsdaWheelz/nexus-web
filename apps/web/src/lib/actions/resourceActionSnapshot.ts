import type { ApiJson, Schema } from "@/lib/api/wire";
import { parseMediaId, type PlayerDescriptor } from "@/lib/lectern/contract";
import { assumeCanonicalResourceRef } from "@/lib/sharing/targets";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

type WireCapability = Schema<"ResourceActionSnapshotOut">["capabilities"][number];

export type ResourceActionCapability =
  | Exclude<WireCapability, { kind: "Playback" }>
  | (Omit<Extract<WireCapability, { kind: "Playback" }>, "playerDescriptor"> & {
      readonly playerDescriptor: PlayerDescriptor;
    });

export type ResourceActionSnapshot = Omit<
  Schema<"ResourceActionSnapshotOut">,
  "ref" | "capabilities"
> & {
  readonly ref: CanonicalResourceRef;
  readonly capabilities: readonly ResourceActionCapability[];
};

export function adaptResourceActionSnapshotResolveResponse(
  response: ApiJson<"/resource-items/action-snapshots/resolve", "post">["data"],
): readonly ResourceActionSnapshot[] {
  return response.snapshots.map((snapshot) => ({
    ...snapshot,
    ref: assumeCanonicalResourceRef(snapshot.ref),
    capabilities: snapshot.capabilities.map((capability) =>
      capability.kind === "Playback"
        ? {
            ...capability,
            playerDescriptor: {
              ...capability.playerDescriptor,
              mediaId: parseMediaId(capability.playerDescriptor.mediaId),
            },
          }
        : capability,
    ),
  }));
}
