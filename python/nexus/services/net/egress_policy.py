"""Pre-DNS hostname denylist and private-IP predicate for outbound egress.

Dependency-free so URL validation and image fetching can both share the policy
without either pulling in the other's transport stack.
"""

from __future__ import annotations

from ipaddress import IPv4Address, IPv6Address

HOSTNAME_DENYLIST_EXACT = frozenset({"localhost"})
HOSTNAME_DENYLIST_SUFFIXES = (".local", ".internal", ".lan", ".home")


def is_private_ip(ip: IPv4Address | IPv6Address) -> bool:
    """Check if IP address is private/reserved.

    Blocks:
    - Loopback (127.0.0.0/8, ::1)
    - Private (10/8, 172.16/12, 192.168/16)
    - Link-local (169.254/16, fe80::/10)
    - Metadata endpoint (169.254.169.254)
    """
    # Use stdlib methods where available
    if ip.is_loopback:
        return True
    if ip.is_private:
        return True
    if ip.is_link_local:
        return True
    if ip.is_reserved:
        return True

    # Explicit check for metadata endpoint
    if isinstance(ip, IPv4Address) and str(ip) == "169.254.169.254":
        return True

    return False
