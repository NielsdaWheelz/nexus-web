"""Neutral HTTP egress helpers.

`safe_fetch.safe_get` is the SSRF-safe chokepoint for feed-controlled URLs (RSS feeds,
chapters, transcript sidecars). `http_retry.get_json_with_retry` is for trusted
first-party provider APIs (no SSRF guard). They are deliberately separate.
"""
