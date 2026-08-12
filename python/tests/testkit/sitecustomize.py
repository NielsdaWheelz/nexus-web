"""Install the test network boundary before a spawned program starts."""

import os

from network import install_network_guard, install_test_tls_ca

if os.environ.get("NEXUS_TEST_DENY_EXTERNAL_NETWORK") == "1":
    install_network_guard()
    install_test_tls_ca()
