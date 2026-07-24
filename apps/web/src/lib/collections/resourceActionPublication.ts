import type {
  ActionPublication,
  RichResourceActionGroups,
} from "@/lib/actions/resourceActions";
import type { ResourceActionSubject } from "@/lib/resources/resourceActionTarget";
import type { ActionDescriptor } from "@/lib/ui/actionDescriptor";

export function publishResourceRowActions({
  target,
  rich,
  view,
}: {
  readonly target: ResourceActionSubject;
  readonly rich: RichResourceActionGroups;
  readonly view: readonly ActionDescriptor[];
}): ActionPublication {
  return {
    kind: "ResourceMenu",
    target,
    groups: {
      core: [],
      operations: rich.operations,
      relationships: rich.relationships,
      view,
    },
  };
}
