"""Image retention stays inside its byte budget, including oversized replacements."""

from nexus.services.image_proxy import CacheEntry, ImageCache


def test_byte_budget_evicts_least_recently_used_image() -> None:
    cache = ImageCache(max_entries=4, max_bytes=10)
    older = CacheEntry(b"aaaa", "image/png", '"older"')
    newer = CacheEntry(b"bbbb", "image/png", '"newer"')
    incoming = CacheEntry(b"cccc", "image/png", '"incoming"')
    cache.put("older", older)
    cache.put("newer", newer)
    assert cache.get("older") is older

    cache.put("incoming", incoming)

    assert cache.get("newer") is None
    assert cache.get("older") is older
    assert cache.get("incoming") is incoming
    assert cache.total_bytes == 8


def test_oversized_image_does_not_evict_other_cached_images() -> None:
    cache = ImageCache(max_entries=4, max_bytes=4)
    retained = CacheEntry(b"abcd", "image/png", '"retained"')
    cache.put("retained", retained)

    cache.put("large", CacheEntry(b"abcde", "image/png", '"large"'))

    assert cache.get("large") is None
    assert cache.get("retained") is retained
    assert cache.total_bytes == 4


def test_oversized_replacement_removes_its_stale_cache_entry() -> None:
    cache = ImageCache(max_entries=4, max_bytes=4)
    cache.put("image", CacheEntry(b"old", "image/png", '"old"'))

    cache.put("image", CacheEntry(b"larger", "image/png", '"new"'))

    assert cache.get("image") is None
    assert cache.total_bytes == 0
