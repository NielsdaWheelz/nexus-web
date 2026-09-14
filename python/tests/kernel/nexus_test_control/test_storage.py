from pathlib import Path

from nexus_test_control.storage import available_storage_mib


def test_available_storage_uses_the_lowest_write_owner(
    tmp_path: Path,
) -> None:
    docker_root = tmp_path / "docker"
    docker_root.mkdir()
    observed: list[Path] = []
    available = {
        tmp_path.resolve(): 12 * 1024 * 1024 * 1024,
        docker_root.resolve(): 9 * 1024 * 1024 * 1024,
    }

    def free_bytes(root: Path) -> int:
        observed.append(root)
        return available[root]

    assert (
        available_storage_mib(
            tmp_path,
            include_docker=True,
            _free_bytes=free_bytes,
            _docker_root_path=lambda: docker_root.resolve(),
        )
        == 9 * 1024
    )
    assert observed == [tmp_path.resolve(), docker_root.resolve()]


def test_workspace_only_storage_does_not_contact_docker(
    tmp_path: Path,
) -> None:
    def unexpected_docker() -> Path:
        raise AssertionError("Docker must remain untouched")

    assert (
        available_storage_mib(
            tmp_path,
            include_docker=False,
            _free_bytes=lambda _root: 10 * 1024 * 1024 * 1024,
            _docker_root_path=unexpected_docker,
        )
        == 10 * 1024
    )


def test_unknown_storage_fails_closed(tmp_path: Path) -> None:
    def unavailable(_root: Path) -> int:
        raise OSError("unavailable")

    assert (
        available_storage_mib(
            tmp_path,
            include_docker=False,
            _free_bytes=unavailable,
        )
        is None
    )
