"""Release API proof must not start processes inside a memory-constrained API."""

from pathlib import Path
from unittest.mock import Mock

import pytest
from deploy.hetzner import release

from nexus.release_artifact import CandidateImages, CandidateManifest


@pytest.mark.parametrize("wrong_version", [False, True])
def test_backend_http_proof_runs_on_host_and_preserves_contract_failures(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, wrong_version: bool
) -> None:
    candidate = CandidateManifest(
        schema_version=2,
        source_sha="a" * 40,
        repository="NielsdaWheelz/nexus-web",
        images=CandidateImages(
            api="ghcr.io/nielsdawheelz/nexus-api@sha256:" + "b" * 64,
            worker="ghcr.io/nielsdawheelz/nexus-worker@sha256:" + "c" * 64,
        ),
        expected_database_revision="0230",
        expected_oracle_manifest_digest="sha256:" + "d" * 64,
    )
    host = release.HostRelease(release.ReleasePaths.under(tmp_path))
    monkeypatch.setattr(host, "_service_ipv4_address", lambda *_args: "172.18.0.4")
    monkeypatch.setattr(
        host, "_compose", Mock(side_effect=AssertionError("API HTTP proof started a process"))
    )
    version = {
        "data": {
            "source_sha": "f" * 40 if wrong_version else candidate.source_sha,
            "expected_database_revision": candidate.expected_database_revision,
            "expected_oracle_manifest_digest": candidate.expected_oracle_manifest_digest,
            "task_contract_digest": "e" * 64,
        }
    }
    calls: list[str] = []

    def fetch(url: str, *, operation: str) -> tuple[dict[str, object], dict[str, str]]:
        calls.append(url)
        if url == "http://172.18.0.4:8000/version":
            assert operation == "api-http:version"
            return version, {}
        assert url == "http://172.18.0.4:8000/readyz"
        assert operation == "api-http:readyz"
        return {"data": {"status": "not-ready"}}, {}

    monkeypatch.setattr(host, "_fetch_json", fetch)
    expected = release.PermanentReleaseFailure if wrong_version else release.ExternalCommandFailed
    with pytest.raises(expected, match="API runtime identity|API readiness contract"):
        host._prove_backend(
            bundle=tmp_path,
            candidate=candidate,
            attempt=Mock(spec=release.ReleaseAttempt, config_path=str(tmp_path / "config.env")),
            require_codex_agent_host=False,
        )
    assert calls == ["http://172.18.0.4:8000/version"] + (
        [] if wrong_version else ["http://172.18.0.4:8000/readyz"]
    )
