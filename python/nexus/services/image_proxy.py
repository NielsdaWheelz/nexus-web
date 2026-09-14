"""Fetch validated artwork; byte retention belongs to the private browser cache."""

from nexus.config import require_image_decoder_limits
from nexus.services.image_validation import (
    ValidatedImage,
    create_http_client,
    fetch_validated_image,
)


def fetch_image(url: str) -> ValidatedImage:
    with create_http_client() as client:
        return fetch_validated_image(url, client, decoder_limits=require_image_decoder_limits())
