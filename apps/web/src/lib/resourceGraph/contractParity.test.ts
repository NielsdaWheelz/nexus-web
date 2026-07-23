import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESOURCE_CAPABILITIES,
  SYNAPSE_SOURCE_SCHEMES,
} from "@/lib/resources/resourceCapabilities";
import { EDGE_KINDS, EDGE_ORIGINS } from "./connections";
import { RESOURCE_SCHEMES } from "./resourceRef";

const REPO_ROOT = join(process.cwd(), "../..");

function quotedValues(source: string, pattern: RegExp): string[] {
  const match = source.match(pattern);
  if (!match) throw new Error(`Pattern did not match: ${pattern}`);
  return Array.from(match[1].matchAll(/"([^"]+)"/g), (value) => value[1]);
}

function backendResourceCapabilities(): unknown {
  const script = String.raw`
import ast
import json
from pathlib import Path

def camel(name):
    head, *tail = name.split("_")
    return head + "".join(part.title() for part in tail)

# Recursively unwraps a keyword value so nested dataclass calls, enum member
# references, and sequences of either all round-trip instead of failing
# ast.literal_eval:
#  - a nested dataclass call (e.g. ResourceUserRelationPolicy(...), or the
#    Resource arm of ResourceInspectorPolicy) becomes a nested camelCase dict;
#  - an enum member reference (e.g. ResourceInspectorSurfaceRole.Contents)
#    becomes its bare member name, which is also its string value under this
#    codebase's PascalCase-StrEnum convention (docs/rules/naming.md);
#  - a tuple/list (e.g. default_surface_order=(Role.Contents, Role.Dossier))
#    becomes a JSON array via elementwise recursion, since ast.literal_eval
#    rejects a tuple containing a non-literal element such as an Attribute.
# Plain literals (str/int/bool/None/...) — including the bare None arm of
# the ResourceInspectorPolicy union — fall through to ast.literal_eval unchanged.
def eval_value(node):
    if isinstance(node, ast.Call):
        return {
            camel(keyword.arg): eval_value(keyword.value)
            for keyword in node.keywords
            if keyword.arg is not None
        }
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, (ast.Tuple, ast.List)):
        return [eval_value(element) for element in node.elts]
    return ast.literal_eval(node)

tree = ast.parse(Path("python/nexus/services/resource_items/capabilities.py").read_text())
for node in tree.body:
    if isinstance(node, ast.Assign):
        is_capabilities = any(isinstance(target, ast.Name) and target.id == "RESOURCE_ITEM_CAPABILITIES" for target in node.targets)
        value = node.value
    elif isinstance(node, ast.AnnAssign):
        is_capabilities = isinstance(node.target, ast.Name) and node.target.id == "RESOURCE_ITEM_CAPABILITIES"
        value = node.value
    else:
        continue
    if not is_capabilities:
        continue
    if not isinstance(value, ast.Dict):
        raise AssertionError("RESOURCE_ITEM_CAPABILITIES must be a dict literal")
    manifest = {}
    for key, row in zip(value.keys, value.values, strict=True):
        if not isinstance(row, ast.Call):
            raise AssertionError("capability rows must be ResourceItemCapability calls")
        manifest[ast.literal_eval(key)] = {
            camel(keyword.arg): eval_value(keyword.value)
            for keyword in row.keywords
            if keyword.arg is not None
        }
    print(json.dumps(manifest, sort_keys=True))
    break
else:
    raise AssertionError("RESOURCE_ITEM_CAPABILITIES not found")
`;
  return JSON.parse(
    execFileSync("python3", ["-c", script], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }),
  );
}

describe("frontend resource graph vocabulary", () => {
  it("matches backend ResourceScheme, EdgeKind, and EdgeOrigin literals", () => {
    const refs = readFileSync(
      join(REPO_ROOT, "python/nexus/services/resource_graph/refs.py"),
      "utf8",
    );
    const schemas = readFileSync(
      join(REPO_ROOT, "python/nexus/services/resource_graph/schemas.py"),
      "utf8",
    );

    expect([...RESOURCE_SCHEMES]).toEqual(
      quotedValues(refs, /RESOURCE_SCHEMES:.*?=\s*\(([\s\S]*?)\)/),
    );
    expect([...EDGE_KINDS]).toEqual(
      quotedValues(schemas, /EdgeKind = Literal\[([\s\S]*?)\]/),
    );
    expect([...EDGE_ORIGINS]).toEqual(
      quotedValues(schemas, /EdgeOrigin = Literal\[([\s\S]*?)\]/),
    );
    const policy = readFileSync(
      join(REPO_ROOT, "python/nexus/services/resource_graph/policy.py"),
      "utf8",
    );
    expect([...SYNAPSE_SOURCE_SCHEMES]).toEqual(
      quotedValues(policy, /SYNAPSE_SOURCE_SCHEMES:.*?=\s*\(([\s\S]*?)\)/),
    );
  });

  it("matches backend resource item capability projection", () => {
    expect(RESOURCE_CAPABILITIES).toEqual(backendResourceCapabilities());
  });
});
