from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

from nexus_test_control.policy import fault_manifest_violations
from nexus_test_control.sensitivity import fault_definition


def test_fault_owner_resolves_route_brackets_literally(tmp_path: Path) -> None:
    owner = "apps/web/src/app/(authenticated)/media/[id]/reader.browser.test.tsx"
    path = tmp_path / owner
    path.parent.mkdir(parents=True)
    path.write_text('import { it } from "vitest";\nit("source identity", () => {});\n')
    source = tmp_path / "apps/web/src/reader.ts"
    source.write_text("export const generation = 7;\n")
    subprocess.run(("git", "init", "-q"), cwd=tmp_path, check=True)
    patch = (
        "diff --git a/apps/web/src/reader.ts b/apps/web/src/reader.ts\n"
        "--- a/apps/web/src/reader.ts\n+++ b/apps/web/src/reader.ts\n"
        "@@ -1 +1 @@\n-export const generation = 7;\n+export const generation = 8;\n"
    )
    directory = tmp_path / "testdata/faults"
    directory.mkdir(parents=True)
    (directory / "source.patch").write_text(patch)
    proof = f"vitest:{owner}"
    row = {
        "id": "source-substitution",
        "patch": "testdata/faults/source.patch",
        "sha256": hashlib.sha256(patch.encode()).hexdigest(),
        "proofs": [proof],
        "expected_failure": "source identity changed",
    }
    manifest = directory / "manifest.json"
    manifest.write_text(json.dumps({"version": 1, "faults": [row]}))
    registry = tmp_path / "testdata/proofs.json"
    registry.write_text(json.dumps({"priority_risks": [{"proofs": [proof]}]}))

    assert not fault_manifest_violations(tmp_path), "literal route proof owner was rejected"
    assert fault_definition(tmp_path, row["id"], proof).proofs == (proof,)

    for missing in (owner.replace("[id]", "id"), owner.replace("[id]", "*")):
        row["proofs"] = [f"vitest:{missing}"]
        manifest.write_text(json.dumps({"version": 1, "faults": [row]}))
        assert "fault-proof" in {item.rule for item in fault_manifest_violations(tmp_path)}, (
            "exact proof lookup matched another route owner"
        )
