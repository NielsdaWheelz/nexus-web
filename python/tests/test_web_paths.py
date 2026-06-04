"""Tests for browser-facing BFF path templates."""

import uuid

import pytest

from nexus import web_paths

pytestmark = pytest.mark.unit

_SAMPLE_UUID = uuid.UUID("12345678-1234-5678-1234-567812345678")


class TestIsMediaAssetPath:
    def test_valid_asset_path(self):
        path = f"/api/media/{_SAMPLE_UUID}/assets/cover.jpg"
        assert web_paths.is_media_asset_path(path) is True

    def test_image_proxy_path_is_not_asset(self):
        assert web_paths.is_media_asset_path("/api/media/image") is False

    def test_bare_media_uuid_is_not_asset(self):
        assert web_paths.is_media_asset_path(f"/api/media/{_SAMPLE_UUID}") is False

    def test_empty_string(self):
        assert web_paths.is_media_asset_path("") is False

    def test_assets_without_uuid_is_not_asset(self):
        assert web_paths.is_media_asset_path("/api/media/not-a-uuid/assets/x") is False


class TestMediaImageUrl:
    def test_output(self):
        assert web_paths.media_image_url("https%3A%2F%2Fexample.com%2Fimg.png") == (
            "/api/media/image?url=https%3A%2F%2Fexample.com%2Fimg.png"
        )


class TestMediaAssetUrl:
    def test_output(self):
        assert web_paths.media_asset_url(_SAMPLE_UUID, "cover.jpg") == (
            f"/api/media/{_SAMPLE_UUID}/assets/cover.jpg"
        )


class TestOraclePlateUrl:
    def test_output(self):
        assert web_paths.oracle_plate_url(_SAMPLE_UUID) == (
            f"/api/oracle/plates/{_SAMPLE_UUID}"
        )
