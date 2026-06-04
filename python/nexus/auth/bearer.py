"""The one bearer-token parser. Callers map None to their own error code."""


def parse_bearer_token(authorization: str | None) -> str | None:
    """Return the bearer token, or None if the header is absent or malformed."""
    if not authorization or not authorization.lower().startswith("bearer "):
        return None
    token = authorization[7:].strip()
    return token or None
