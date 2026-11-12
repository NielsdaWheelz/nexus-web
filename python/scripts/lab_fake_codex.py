"""Synthetic account/upstream setup for the ordinary Linux native supervisor.

The account and host identity survive container restart for this lab's lifetime.
Host API and workers reach this same container; only upstream responses are fake.
"""

from __future__ import annotations

import argparse
import asyncio
import base64
import json
import os
import secrets
import time
from pathlib import Path

from apps.codex_agent.main import serve
from apps.codex_agent.state import initialize, read


def token(claims: dict[str, object]) -> str:
    def encode(value: object) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    return f"{encode({'alg': 'RS256', 'typ': 'JWT'})}.{encode(claims)}.{secrets.token_urlsafe(32)}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--ca-file", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    credential = Path(os.environ["NEXUS_CODEX_CREDENTIAL_FILE"])
    account = credential.parent
    account.mkdir(mode=0o700, parents=True, exist_ok=True)
    if (account / "host-state.json").exists():
        read(account)
    else:
        account_id = "lab-fake-account"
        claims: dict[str, object] = {
            "exp": int(time.time()) + 30 * 86400,
            "https://api.openai.com/auth": {
                "chatgpt_plan_type": "pro",
                "chatgpt_account_id": account_id,
                "chatgpt_user_id": "lab-fake-user",
            },
        }
        with credential.open("x") as stream:
            json.dump(
                {
                    "OPENAI_API_KEY": None,
                    "tokens": {
                        "id_token": token(claims | {"email": "lab-fake@example.test"}),
                        "access_token": token(claims),
                        "refresh_token": secrets.token_urlsafe(32),
                        "account_id": account_id,
                    },
                    "last_refresh": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                },
                stream,
            )
        initialize(account)
    asyncio.run(
        serve(
            native_settings=(
                "-c",
                f"openai_base_url={json.dumps(args.origin + '/v1')}",
                "-c",
                f"chatgpt_base_url={json.dumps(args.origin + '/backend-api')}",
            ),
            native_environment={
                "CODEX_CA_CERTIFICATE": str(args.ca_file),
                "CODEX_REFRESH_TOKEN_URL_OVERRIDE": args.origin + "/oauth/token",
            },
        )
    )


if __name__ == "__main__":
    main()
