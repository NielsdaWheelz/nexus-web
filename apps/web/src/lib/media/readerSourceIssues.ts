import {
  expectArray,
  expectCanonicalRfcUuid,
  expectExactRecord,
  expectNonnegativeInteger,
  expectNonemptyString,
  expectRecord,
} from "@/lib/validation";

export type ReaderSourceIssue =
  | {
      readonly kind: "MissingImage";
      readonly fragment_id: string;
      readonly marker_ordinal: number;
      readonly resource_path: string;
    }
  | {
      readonly kind: "UnresolvedNavigationTarget";
      readonly node_id: string;
      readonly href: string;
    };

function packagePath(raw: unknown, name: string): string {
  const value = expectNonemptyString(raw, name);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new TypeError(`${name} must be a normalized package path`);
  }
  return value;
}

function localHref(raw: unknown, name: string): string {
  const value = expectNonemptyString(raw, name);
  if (
    value.startsWith("/") ||
    value.includes("\\") ||
    /^[a-z][a-z0-9+.-]*:/iu.test(value) ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must be a local href`);
  }
  return value;
}

export function decodeReaderSourceIssues(raw: unknown, name: string): ReaderSourceIssue[] {
  if (!Array.isArray(raw) || raw.length > 10_000) {
    throw new TypeError(`${name} must contain at most 10000 issues`);
  }
  return expectArray(raw, (entry, index): ReaderSourceIssue => {
    const itemName = `${name}[${index}]`;
    const kind = expectRecord(entry, itemName).kind;
    if (kind === "MissingImage") {
      const item = expectExactRecord(
        entry,
        ["kind", "fragment_id", "marker_ordinal", "resource_path"],
        itemName,
      );
      return {
        kind,
        fragment_id: expectCanonicalRfcUuid(item.fragment_id, `${itemName}.fragment_id`),
        marker_ordinal: expectNonnegativeInteger(item.marker_ordinal, `${itemName}.marker_ordinal`),
        resource_path: packagePath(item.resource_path, `${itemName}.resource_path`),
      };
    }
    if (kind === "UnresolvedNavigationTarget") {
      const item = expectExactRecord(entry, ["kind", "node_id", "href"], itemName);
      const nodeId = expectNonemptyString(item.node_id, `${itemName}.node_id`);
      if ([...nodeId].length > 255) throw new TypeError(`${itemName}.node_id exceeds 255 characters`);
      return {
        kind,
        node_id: nodeId,
        href: localHref(item.href, `${itemName}.href`),
      };
    }
    throw new TypeError(`${itemName}.kind is unknown`);
  }, name);
}
