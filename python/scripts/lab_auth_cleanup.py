"""Remove one lab's Supabase resources by their exact project label.

The minted auth project owns every listed container, volume and network. Stop
containers gracefully before nonforced removal; never use daemon-wide prune
operations. Errors propagate without retries, preserving the lab's recovery
inputs. Repeating after successful removal observes an empty namespace.
"""

from __future__ import annotations

import argparse
import re
import subprocess


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", help="the lab-auth-<12 hex> project to remove")
    project = parser.parse_args().project
    if re.fullmatch(r"lab-auth-[0-9a-f]{12}", project) is None:
        parser.error("project must be a minted lab-auth-<12 hex> identity")
    label = f"label=com.supabase.cli.project={project}"
    containers = subprocess.run(
        ["docker", "container", "ls", "-a", "-q", "--filter", label],
        check=True,
        stdout=subprocess.PIPE,
        text=True,
        timeout=10,
    ).stdout.split()
    if containers:
        subprocess.run(
            ["docker", "container", "stop", "--timeout", "30", *containers],
            check=True,
            timeout=40,
        )
        subprocess.run(["docker", "container", "rm", *containers], check=True, timeout=20)
    for kind in ("volume", "network"):
        identifiers = subprocess.run(
            ["docker", kind, "ls", "-q", "--filter", label],
            check=True,
            stdout=subprocess.PIPE,
            text=True,
            timeout=10,
        ).stdout.split()
        if identifiers:
            subprocess.run(["docker", kind, "rm", *identifiers], check=True, timeout=20)


if __name__ == "__main__":
    main()
