import type { Schema } from "@/lib/api/wire";
import type { MediaId, PlayerDescriptor } from "@/lib/lectern/contract";
import type { CanonicalResourceRef } from "@/lib/sharing/types";

type WireCapability = Schema<"ResourceActionSnapshotOut">["capabilities"][number];
export type ServerActionAvailability = WireCapability["availability"];
export type ResourceActionCapability =
  | Exclude<WireCapability, { kind: "Playback" }>
  | (Omit<Extract<WireCapability, { kind: "Playback" }>, "playerDescriptor"> & { playerDescriptor: PlayerDescriptor });
export type ResourceActionSnapshot = Omit<Schema<"ResourceActionSnapshotOut">, "ref" | "capabilities"> & {
  ref: CanonicalResourceRef;
  capabilities: readonly ResourceActionCapability[];
};

export function projectResourceActionSnapshot(value: Schema<"ResourceActionSnapshotOut">): ResourceActionSnapshot {
  return {
    ...value,
    // justify-type-assertion: backend canonical refs lose only their product brand in JSON.
    ref: value.ref as CanonicalResourceRef,
    capabilities: value.capabilities.map((capability): ResourceActionCapability => {
      switch (capability.kind) {
        case "Playback":
          return {
            ...capability,
            playerDescriptor: {
              ...capability.playerDescriptor,
              // justify-type-assertion: backend PlayerDescriptor owns this validated UUID.
              mediaId: capability.playerDescriptor.mediaId as MediaId,
            },
          };
        default:
          return capability;
      }
    }),
  };
}
