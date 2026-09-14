"""Exact container ownership for API capacity and worker artifact proofs."""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from uuid import uuid4

import httpx

from nexus_test_control.model import Resource, ResourceKind
from nexus_test_control.runtime import (
    RuntimeContractError,
    container_resource_identity,
    forget_cleaned,
    local_docker_host,
    read_ledger,
    read_runtime,
    record_created,
    record_planned,
)

_IMAGE = re.compile(r"(?:ghcr\.io/nielsdawheelz/nexus-(?:api|worker)@)?sha256:[0-9a-f]{64}\Z")


def local_docker(arguments: Sequence[str], *, timeout: int = 60) -> str:
    result = subprocess.run(
        ("docker", *arguments),
        env={**os.environ, "DOCKER_HOST": local_docker_host(), "DOCKER_CONTEXT": "default"},
        stdout=subprocess.PIPE,
        # Container logs split application stdout/stderr across the Docker CLI streams.
        stderr=subprocess.STDOUT if arguments[0] == "logs" else subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=True,
    )
    return result.stdout


def create_owned_container(
    repo_root: Path,
    environment: Mapping[str, str],
    run_id: str,
    *,
    role: str,
    image: str,
    arguments: Sequence[str],
    command: Sequence[str],
) -> str:
    if _IMAGE.fullmatch(image) is None:
        raise RuntimeContractError("container proof requires one immutable image")
    name = container_resource_identity(run_id, role)
    resource = Resource(ResourceKind.CONTAINER, name)
    owner = uuid4().hex
    record_planned(repo_root, environment, run_id, resource, external_id=owner)
    local_docker(
        (
            "create",
            *arguments,
            "--name",
            name,
            "--label",
            f"nexus.test.run={run_id}",
            "--label",
            f"nexus.test.owner={owner}",
            "--label",
            f"com.docker.compose.project={read_runtime(repo_root).compose_project}",
            image,
            *command,
        )
    )
    record_created(repo_root, environment, run_id, resource)
    return name


def delete_owned_container(repo_root: Path, run_id: str, name: str, owner: str) -> None:
    names = local_docker(
        ("container", "ls", "--all", "--filter", f"name=^/{name}$", "--format", "{{.Names}}")
    ).splitlines()
    if not names:
        return
    if names != [name]:
        raise RuntimeContractError("owned container lookup was not exact")
    records = json.loads(local_docker(("container", "inspect", name)))
    if not isinstance(records, list) or len(records) != 1:
        raise RuntimeContractError("owned container inspection was not exact")
    labels = records[0]["Config"]["Labels"]
    if (
        labels.get("nexus.test.run") != run_id
        or labels.get("nexus.test.owner") != owner
        or labels.get("com.docker.compose.project") != read_runtime(repo_root).compose_project
    ):
        raise RuntimeContractError("refusing to delete a foreign container")
    local_docker(("container", "rm", "--force", name))


def close_owned_container(repo_root: Path, run_id: str, role: str) -> None:
    resource = Resource(ResourceKind.CONTAINER, container_resource_identity(run_id, role))
    for entry in read_ledger(repo_root, run_id).entries:
        if entry.resource == resource:
            if entry.external_id is None:
                raise RuntimeContractError("owned container lacks its owner token")
            delete_owned_container(repo_root, run_id, resource.identity, entry.external_id)
            forget_cleaned(repo_root, {"NEXUS_ENV": "test"}, run_id, resource)
            return


def wait_api_container_ready(name: str, pid: int, port: int, client: httpx.Client) -> None:
    """Trust readiness only after the exact container owns its API listening socket."""
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        inspection = json.loads(local_docker(("inspect", name)))[0]
        if not inspection["State"]["Running"] or inspection["State"]["Pid"] != pid:
            raise RuntimeContractError("owned API container exited before readiness")
        if inspection["HostConfig"]["PortBindings"] != {
            "8000/tcp": [{"HostIp": "127.0.0.1", "HostPort": str(port)}]
        }:
            raise RuntimeContractError("API container does not own its exact published port")
        try:
            ready = client.get("/readyz", timeout=1)
        except httpx.HTTPError:
            time.sleep(0.05)
            continue
        if ready.status_code != 200:
            time.sleep(0.05)
            continue
        attestation = local_docker(
            (
                "exec",
                name,
                "python",
                "-c",
                "from pathlib import Path; "
                "rows=[line.split() for line in Path('/proc/1/net/tcp').read_text().splitlines()[1:]]; "
                "inodes={row[9] for row in rows if row[1]=='00000000:1F40' and row[3]=='0A'}; "
                "assert any(str(fd.readlink()) in {'socket:['+inode+']' for inode in inodes} "
                "for fd in Path('/proc/1/fd').iterdir()); print('owned')",
            )
        )
        if attestation.strip() != "owned":
            raise RuntimeContractError("healthy API endpoint is not owned by its container")
        return
    raise RuntimeContractError("owned API image/schema did not become ready")
