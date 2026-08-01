from itertools import islice

from nexus_test_control.services import _candidate_ports


def test_port_candidates_exclude_the_host_ephemeral_client_range() -> None:
    candidates = tuple(islice(_candidate_ports(15432, (15432, 15440)), 2))

    assert candidates == (15441, 15442), (
        f"ephemeral client range leaked into allocated test ports: {candidates!r}"
    )
