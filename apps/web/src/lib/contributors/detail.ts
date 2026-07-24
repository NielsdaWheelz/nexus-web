import { parseContributorHandle } from "@/lib/contributors/handle";
import type { ContributorDetail } from "@/lib/contributors/types";
import { decodeStandingActionTarget } from "@/lib/resources/resourceActionTarget";
import {
  expectArray,
  expectBoolean,
  expectExactRecord,
  expectString,
} from "@/lib/validation";

export function decodeContributorDetail(raw: unknown): ContributorDetail {
  const detail = expectExactRecord(
    raw,
    [
      "handle",
      "href",
      "displayName",
      "otherNames",
      "canRename",
      "actionTarget",
    ],
    "ContributorDetail",
  );
  const actionTarget = decodeStandingActionTarget(
    detail.actionTarget,
    "ContributorDetail.actionTarget",
  );
  if (actionTarget.kind !== "Resource") {
    throw new TypeError("ContributorDetail.actionTarget must be Resource");
  }
  return {
    handle: parseContributorHandle(
      expectString(detail.handle, "ContributorDetail.handle"),
    ),
    href: expectString(detail.href, "ContributorDetail.href"),
    displayName: expectString(
      detail.displayName,
      "ContributorDetail.displayName",
    ),
    otherNames: expectArray(
      detail.otherNames,
      (value, index) =>
        expectString(value, `ContributorDetail.otherNames[${index}]`),
      "ContributorDetail.otherNames",
    ),
    canRename: expectBoolean(detail.canRename, "ContributorDetail.canRename"),
    actionTarget,
  };
}
