"""Own one pinned Codex instance with synthetic account state and an explicit fake upstream.

The host API and Linux workers use separate Unix-socket namespaces, so the lab
starts this same entrypoint in each. Only account/provider setup differs from
production; the binary, containment catalog and app-server protocol are real.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import time
from pathlib import Path

import codex_cli_bin
from provider_runtime.agent_runtime import materialize_codex_containment_catalog


def token(claims: dict[str, object]) -> str:
    def encode(value: object) -> str:
        return base64.urlsafe_b64encode(json.dumps(value).encode()).rstrip(b"=").decode()

    return f"{encode({'alg': 'RS256', 'typ': 'JWT'})}.{encode(claims)}.{secrets.token_urlsafe(32)}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--origin", required=True)
    parser.add_argument("--ca-file", required=True, type=Path)
    parser.add_argument("--state", required=True, type=Path)
    parser.add_argument("--socket", required=True, type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    for directory in (args.state, args.state / "home", args.state / "tmp", args.socket.parent):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    expires = int(time.time()) + 30 * 86400
    account_id = "lab-fake-account"
    account = {
        "chatgpt_plan_type": "pro",
        "chatgpt_account_id": account_id,
        "chatgpt_user_id": "lab-fake-user",
    }
    claims: dict[str, object] = {"exp": expires, "https://api.openai.com/auth": account}
    (args.state / "auth.json").write_text(
        json.dumps(
            {
                "OPENAI_API_KEY": None,
                "tokens": {
                    "id_token": token(claims | {"email": "lab-fake@example.test"}),
                    "access_token": token(claims),
                    "refresh_token": secrets.token_urlsafe(32),
                    "account_id": account_id,
                },
                "last_refresh": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
        )
    )
    catalog = materialize_codex_containment_catalog(args.state)
    cwd = args.socket.parent / "cwds/host"
    cwd.mkdir(mode=0o500, parents=True, exist_ok=True)
    args.socket.unlink(missing_ok=True)
    executable = str(codex_cli_bin.bundled_codex_path())
    os.chdir(cwd)
    os.execve(
        executable,
        [
            executable,
            "-c",
            f"model_catalog_json={json.dumps(str(catalog))}",
            "-c",
            f"openai_base_url={json.dumps(args.origin + '/v1')}",
            "-c",
            f"chatgpt_base_url={json.dumps(args.origin + '/backend-api')}",
            "app-server",
            "--listen",
            f"unix://{args.socket}",
            "--strict-config",
        ],
        {
            "CODEX_HOME": str(args.state),
            "CODEX_EXEC_SERVER_URL": "none",
            "CODEX_CA_CERTIFICATE": str(args.ca_file),
            "CODEX_REFRESH_TOKEN_URL_OVERRIDE": args.origin + "/oauth/token",
            "HOME": str(args.state / "home"),
            "TMPDIR": str(args.state / "tmp"),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": os.environ["PATH"],
        },
    )


if __name__ == "__main__":
    main()
