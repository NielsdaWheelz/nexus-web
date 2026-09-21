"""Pre-DNS hostname denylist and the private-address predicate for egress.

Dependency-free so the URL policy and the fetch transport can both share it.
"""

from __future__ import annotations

from ipaddress import IPv4Address, IPv6Address

HOSTNAME_DENYLIST_EXACT = frozenset({"localhost"})
HOSTNAME_DENYLIST_SUFFIXES = (".local", ".internal", ".lan", ".home")


def is_private_ip(ip: IPv4Address | IPv6Address) -> bool:
    """Reject loopback, private, reserved, and link-local addresses.

    Link-local covers 169.254.0.0/16 and therefore the 169.254.169.254 cloud
    metadata endpoint, which is the address this predicate exists for.
    """
    return ip.is_loopback or ip.is_private or ip.is_link_local or ip.is_reserved
