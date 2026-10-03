"""Supervise one persistent stock app-server; account state stays on this host."""

from __future__ import annotations

import asyncio
import signal

from apps.codex_agent.auth_environment import (
    reject_ambient_codex_home,
    reject_subscription_api_key_auth,
)
from apps.codex_agent.native_server import start_native_codex_server
from apps.codex_agent.path_environment import required_absolute_path


async def serve() -> None:
    reject_subscription_api_key_auth()
    reject_ambient_codex_home()
    socket_path = required_absolute_path("NEXUS_CODEX_NATIVE_SOCKET")
    credential_file = required_absolute_path("NEXUS_CODEX_CREDENTIAL_FILE")
    stopping = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signum, stopping.set)
    server = await start_native_codex_server(
        socket_path=socket_path, credential_file=credential_file
    )
    stop_wait = asyncio.create_task(stopping.wait())
    exited = asyncio.create_task(server.process.wait())
    try:
        done, _ = await asyncio.wait({stop_wait, exited}, return_when=asyncio.FIRST_COMPLETED)
        if exited in done and not stopping.is_set():
            raise RuntimeError("persistent Codex app-server exited")
    finally:
        stop_wait.cancel()
        await asyncio.gather(stop_wait, return_exceptions=True)
        await server.stop()
        await exited
        for signum in (signal.SIGINT, signal.SIGTERM):
            loop.remove_signal_handler(signum)


def main() -> None:
    asyncio.run(serve())


if __name__ == "__main__":
    main()
