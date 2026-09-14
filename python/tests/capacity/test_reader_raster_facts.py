"""Actual decoded figure facts, including later canvas and embedded icon pixels.

Staged qualification for docs/tickets/reader-figure-predecode-admission.md: full
frame decoding is not an activated capture path and has no production caller, so
the probe lives with the API image memory qualification owner rather than in
``nexus/services``. It deliberately loads every frame, because Pillow's GIF
metadata walk omits later canvas growth and ICO directory dimensions need not
describe embedded pixels. What it attests is a conservative oriented surface,
never an intrinsic layout size, and never a predecode bound.
"""

import base64
import hashlib
import io
import json
import os
from pathlib import Path

from PIL import Image
from PIL.IcoImagePlugin import IcoImageFile

from nexus.services.image_validation import (
    IMAGE_FORMAT_MIME_TYPES,
    prepare_image_validation_bytes,
    read_exif_orientation,
)


def inspect_reader_raster(data: bytes) -> tuple[str, int, int, int]:
    """Decode one original and report its media type, oriented surface and frames.

    The web proxy's dimension policy does not apply to EPUB figures. Physical
    worker admission owns this allocation experiment; memory failure must not be
    relabeled as malformed content or successful capacity support. Original bytes
    and animation remain unchanged.
    """
    validation, orientation = prepare_image_validation_bytes(data)
    maximum = Image.MAX_IMAGE_PIXELS
    Image.MAX_IMAGE_PIXELS = None
    try:
        with Image.open(
            io.BytesIO(validation), formats=("PNG", "JPEG", "GIF", "WEBP", "BMP", "ICO", "AVIF")
        ) as source:
            media_type = IMAGE_FORMAT_MIME_TYPES[(source.format or "").lower()]
            width = height = count = 0

            def include(frame: Image.Image) -> None:
                nonlocal width, height, count
                frame.load()
                rotation = orientation
                if source.format not in {"JPEG", "PNG"} and (exif := frame.info.get("exif")):
                    rotation = read_exif_orientation(memoryview(exif))
                frame_width, frame_height = frame.size
                if rotation in (5, 6, 7, 8):
                    frame_width, frame_height = frame_height, frame_width
                width, height = max(width, frame_width), max(height, frame_height)
                count += 1

            if isinstance(source, IcoImageFile):
                for index in range(len(source.ico.entry)):
                    with source.ico.frame(index) as frame:
                        include(frame)
            else:
                while True:
                    include(source)
                    try:
                        source.seek(count)
                    except EOFError:
                        break
            return media_type, width, height, count
    finally:
        Image.MAX_IMAGE_PIXELS = maximum


def test_reader_raster_scan_includes_later_gif_canvas_and_embedded_icon_pixels() -> None:
    frames = []
    for color, size in enumerate(((2, 3), (8, 9))):
        with io.BytesIO() as encoded, Image.new("P", size, color) as frame:
            frame.putpalette([channel for level in range(256) for channel in (level,) * 3])
            frame.save(encoded, format="GIF", optimize=False)
            frames.append(encoded.getvalue())
    # The logical screen starts small; the later image descriptor retains its
    # independently authored larger dimensions. Pillow expands that canvas on
    # actual seek/load, but its n_frames-only walk does not expose the expansion.
    # Keep the first logical screen/global palette; append the independently
    # encoded second image block. The shared palette is identical. This avoids
    # Pillow's animation writer cropping later frames to its first-frame size.
    second_block = 13 + 3 * (2 ** ((frames[1][10] & 7) + 1))
    assert frames[1][second_block : second_block + 9] == b",\x00\x00\x00\x00\x08\x00\x09\x00"
    gif = frames[0][:-1] + frames[1][second_block:]
    with io.BytesIO() as encoded:
        with Image.new("RGBA", (32, 32), "green") as icon:
            icon.save(encoded, format="ICO", sizes=[(16, 16), (32, 32)])
        ico = bytearray(encoded.getvalue())
    assert int.from_bytes(ico[4:6], "little") == 2
    # The smaller directory declaration must not conceal the second 32px PNG.
    ico[22:24] = b"\x08\x08"
    retained = []
    for name, data, expected in (
        ("later-gif-canvas", bytes(gif), ("image/gif", 8, 9, 2)),
        ("embedded-ico-pixels", bytes(ico), ("image/x-icon", 32, 32, 2)),
    ):
        digest = hashlib.sha256(data).hexdigest()
        assert inspect_reader_raster(data) == expected
        assert hashlib.sha256(data).hexdigest() == digest
        retained.append(
            {
                "name": name,
                "sha256": digest,
                "source_base64": base64.b64encode(data).decode("ascii"),
                "expected": dict(
                    zip(("media_type", "width", "height", "frame_count"), expected, strict=True)
                ),
            }
        )
    (Path(os.environ["NEXUS_TEST_RESULTS_DIR"]) / "reader-raster-source-facts.json").write_text(
        json.dumps(
            {
                "run_id": os.environ["NEXUS_TEST_RUN_ID"],
                "scope": "independently authored later GIF canvas and concealed ICO pixels; not capacity qualification",
                "cases": retained,
            },
            indent=2,
        )
        + "\n"
    )


def test_reader_raster_scan_keeps_orientation_and_real_animation_facts() -> None:
    for format, expected_type in (
        ("PNG", "image/png"),
        ("JPEG", "image/jpeg"),
        ("WEBP", "image/webp"),
        ("AVIF", "image/avif"),
    ):
        with io.BytesIO() as encoded:
            with Image.new("RGB", (3, 7), "red") as first:
                exif = Image.Exif()
                exif[274] = 6
                first.save(encoded, format=format, exif=exif)
            data = encoded.getvalue()
        assert inspect_reader_raster(data) == (expected_type, 7, 3, 1)
    with io.BytesIO() as encoded:
        with Image.new("RGB", (5, 9), "red") as first, Image.new("RGB", (5, 9), "blue") as last:
            first.save(encoded, format="WEBP", save_all=True, append_images=[last], duration=20)
        assert inspect_reader_raster(encoded.getvalue()) == ("image/webp", 5, 9, 2)
    with io.BytesIO() as encoded, Image.new("RGB", (3, 7), "blue") as bitmap:
        bitmap.save(encoded, format="BMP")
        assert inspect_reader_raster(encoded.getvalue()) == ("image/bmp", 3, 7, 1)
