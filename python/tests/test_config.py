"""Tests for application configuration (S5 PR-02: archive safety settings)."""

import pytest
from pydantic import ValidationError

from nexus.config import Settings


def _make_settings(**overrides) -> Settings:
    """Build a Settings instance with test defaults + overrides."""
    defaults = {
        "DATABASE_URL": "postgresql+psycopg://localhost/test",
        "NEXUS_ENV": "test",
        "SUPABASE_JWKS_URL": "http://localhost:54321/auth/v1/.well-known/jwks.json",
        "SUPABASE_ISSUER": "http://localhost:54321/auth/v1",
        "SUPABASE_AUDIENCES": "authenticated",
    }
    defaults.update(overrides)
    return Settings(**defaults)


class TestEpubArchiveSafetyConfigDefaultsAndFloorValidation:
    """test_epub_archive_safety_config_defaults_and_floor_validation"""

    def test_defaults_match_l2_baseline(self):
        s = _make_settings()
        assert s.max_epub_archive_entries == 10_000
        assert s.max_epub_archive_total_uncompressed_bytes == 536_870_912
        assert s.max_epub_archive_single_entry_uncompressed_bytes == 67_108_864
        assert s.max_epub_archive_compression_ratio == 100
        assert s.max_epub_archive_parse_time_ms == 30_000

    def test_stricter_overrides_accepted(self):
        s = _make_settings(
            MAX_EPUB_ARCHIVE_ENTRIES=5000,
            MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES=268_435_456,
            MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES=33_554_432,
            MAX_EPUB_ARCHIVE_COMPRESSION_RATIO=50,
            MAX_EPUB_ARCHIVE_PARSE_TIME_MS=15_000,
        )
        assert s.max_epub_archive_entries == 5000
        assert s.max_epub_archive_total_uncompressed_bytes == 268_435_456
        assert s.max_epub_archive_single_entry_uncompressed_bytes == 33_554_432
        assert s.max_epub_archive_compression_ratio == 50
        assert s.max_epub_archive_parse_time_ms == 15_000

    def test_weaker_entries_rejected(self):
        with pytest.raises(ValidationError, match="MAX_EPUB_ARCHIVE_ENTRIES"):
            _make_settings(MAX_EPUB_ARCHIVE_ENTRIES=20_000)

    def test_weaker_total_bytes_rejected(self):
        with pytest.raises(ValidationError, match="MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES"):
            _make_settings(MAX_EPUB_ARCHIVE_TOTAL_UNCOMPRESSED_BYTES=1_000_000_000)

    def test_weaker_single_entry_rejected(self):
        with pytest.raises(
            ValidationError, match="MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES"
        ):
            _make_settings(MAX_EPUB_ARCHIVE_SINGLE_ENTRY_UNCOMPRESSED_BYTES=100_000_000)

    def test_weaker_compression_ratio_rejected(self):
        with pytest.raises(ValidationError, match="MAX_EPUB_ARCHIVE_COMPRESSION_RATIO"):
            _make_settings(MAX_EPUB_ARCHIVE_COMPRESSION_RATIO=200)

    def test_weaker_parse_time_rejected(self):
        with pytest.raises(ValidationError, match="MAX_EPUB_ARCHIVE_PARSE_TIME_MS"):
            _make_settings(MAX_EPUB_ARCHIVE_PARSE_TIME_MS=60_000)

    def test_zero_value_rejected(self):
        with pytest.raises(ValidationError, match="must be >= 1"):
            _make_settings(MAX_EPUB_ARCHIVE_ENTRIES=0)
