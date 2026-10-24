"""Provider TLS adds explicit operator roots to normal verified trust.

Generation and embeddings share this policy. Ambient proxy/CA variables never
configure these clients; endpoint origins are validated by provider-runtime.
"""

import ssl

import httpx


def provider_ssl_context(ca_pem: str | None) -> ssl.SSLContext:
    context = httpx.create_ssl_context(trust_env=False)
    if ca_pem is not None:
        context.load_verify_locations(cadata=ca_pem)
    return context
