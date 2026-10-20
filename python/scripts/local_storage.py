"""Provision local S3 buckets and exact browser-origin CORS for dev and lab.

Retry rule: bucket creation is idempotent; each call replaces the complete CORS
policy. Credentials and an http localhost/127.0.0.1 endpoint are required.
This local administrative operation stays out
of the application's StorageClient and never changes production buckets.
"""

import argparse
from urllib.parse import urlsplit

from boto3.session import Session
from botocore.client import Config
from botocore.exceptions import ClientError

from nexus.config import Environment, Settings, get_settings


def provision_storage(settings: Settings, *, allowed_origins: list[str]) -> None:
    """Create/check the configured local bucket and replace its exact-origin CORS."""
    if settings.nexus_env != Environment.LOCAL:
        raise ValueError("local storage provisioning requires NEXUS_ENV=local")
    if not (
        settings.r2_s3_api_origin
        and settings.r2_access_key_id
        and settings.r2_secret_access_key
        and settings.r2_bucket
    ):
        raise ValueError("local storage requires all R2_* credentials, origin and bucket")
    endpoint = urlsplit(settings.r2_s3_api_origin)
    if (
        endpoint.scheme != "http"
        or endpoint.hostname not in ("localhost", "127.0.0.1")
        or endpoint.username is not None
        or endpoint.password is not None
        or endpoint.path not in ("", "/")
        or "?" in settings.r2_s3_api_origin
        or "#" in settings.r2_s3_api_origin
    ):
        raise ValueError(
            "local storage administration requires an http localhost or 127.0.0.1 endpoint"
        )
    if not allowed_origins:
        raise ValueError("local storage requires at least one exact browser origin")
    for origin in allowed_origins:
        parsed = urlsplit(origin)
        if (
            parsed.scheme not in ("http", "https")
            or not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
            or "*" in origin
        ):
            raise ValueError("storage CORS origins must be exact http or https origins")
    client = Session().client(
        "s3",
        endpoint_url=settings.r2_s3_api_origin,
        aws_access_key_id=settings.r2_access_key_id,
        aws_secret_access_key=settings.r2_secret_access_key.get_secret_value(),
        region_name=settings.r2_region,
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            connect_timeout=5,
            read_timeout=10,
            retries={"mode": "standard", "total_max_attempts": 3},
        ),
    )
    try:
        try:
            client.head_bucket(Bucket=settings.r2_bucket)
        except ClientError as exc:
            if exc.response["Error"]["Code"] not in ("404", "NoSuchBucket", "NotFound"):
                raise
            try:
                client.create_bucket(Bucket=settings.r2_bucket)
            except ClientError as create_exc:
                if create_exc.response["Error"]["Code"] != "BucketAlreadyOwnedByYou":
                    raise
        client.put_bucket_cors(
            Bucket=settings.r2_bucket,
            CORSConfiguration={
                "CORSRules": [
                    {
                        "AllowedOrigins": allowed_origins,
                        "AllowedMethods": ["GET", "HEAD", "PUT"],
                        "AllowedHeaders": ["content-type", "content-length", "range", "x-amz-*"],
                        "ExposeHeaders": [
                            "accept-ranges",
                            "content-range",
                            "content-length",
                            "content-type",
                            "etag",
                        ],
                        "MaxAgeSeconds": 3600,
                    }
                ]
            },
        )
    finally:
        client.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="provision local bucket and browser CORS")
    parser.add_argument("--origin", action="append", required=True, help="exact allowed web origin")
    args = parser.parse_args()
    provision_storage(get_settings(), allowed_origins=args.origin)
    print("local storage bucket and exact-origin cors ready")


if __name__ == "__main__":
    main()
