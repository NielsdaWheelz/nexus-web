"""Unit tests for PDF locking helpers."""

from uuid import uuid4

from nexus.services.pdf_locking import derive_media_coordination_lock_key


class TestMediaCoordinationLockKey:
    """test_pr04_pdf_locking_media_coordination_key_is_stable_and_namespaced"""

    def test_deterministic(self):
        mid = uuid4()
        k1 = derive_media_coordination_lock_key(mid)
        k2 = derive_media_coordination_lock_key(mid)
        assert k1 == k2

    def test_different_media_different_key(self):
        k1 = derive_media_coordination_lock_key(uuid4())
        k2 = derive_media_coordination_lock_key(uuid4())
        assert k1 != k2

    def test_key_is_int(self):
        k = derive_media_coordination_lock_key(uuid4())
        assert isinstance(k, int)
