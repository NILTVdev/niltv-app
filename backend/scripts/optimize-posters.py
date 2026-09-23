"""
optimize-posters — shrink oversized poster frames and guarantee Cache-Control
on every media object.

Python rather than tsx (the convention for scripts/ here) for one reason: this
needs an image encoder and the JS toolchain in this repo has none. Adding a
native dependency like sharp to the workspace for a maintenance script is a
worse trade than a standalone script using Pillow, which is already present.

Two passes over the stage's HLS bucket:

1. Posters. Ingest mirrors Instagram's thumbnail byte-for-byte, and Instagram
   serves whatever it has, often a few hundred KB for images that are never
   displayed larger than the 720x1280 video frame behind them. They are
   re-encoded to fit within the video's own dimensions at progressive JPEG
   quality 78, which is visually indistinguishable at phone size.

2. Cache-Control. Everything under video/ is immutable — a new clip gets a new
   id — but only the objects ingest uploaded carried the header; MediaConvert
   outputs and anything older did not. The CloudFront response-headers policy
   now stamps it for viewers regardless, but setting it on the object as well
   is what lets CloudFront itself hold the file for a year instead of falling
   back to the cache policy's default TTL.

Both passes are idempotent: a poster already within budget is left alone, and
an object that already has the header is not rewritten.

    python scripts/optimize-posters.py --stage dev --dry-run
    python scripts/optimize-posters.py --stage dev

Dependencies are boto3 and Pillow. They are not part of the npm workspace, so a
fresh virtualenv will not have them:

    pip install boto3 pillow
"""

import argparse
import io
import sys

try:
    import boto3
    from PIL import Image
except ModuleNotFoundError as exc:  # pragma: no cover - environment guard
    raise SystemExit(
        f"missing dependency: {exc.name}\n"
        "This script needs boto3 and Pillow, which are not installed by the npm\n"
        "workspace. In your current interpreter (a virtualenv will not inherit\n"
        "them from a global install), run:\n\n"
        "    pip install boto3 pillow\n"
    ) from exc

CACHE_CONTROL = "public, max-age=31536000, immutable"

# Posters sit behind a 720x1280 video and are never shown larger than it.
MAX_EDGE = 1280
JPEG_QUALITY = 78
# Below this a re-encode is not worth the quality cost.
REWRITE_OVER_BYTES = 120 * 1024


def resolve_bucket(s3, stage: str) -> str:
    prefix = f"niltv-{stage}-video-hls-"
    for b in s3.list_buckets()["Buckets"]:
        if b["Name"].startswith(prefix):
            return b["Name"]
    raise SystemExit(f"no bucket matching {prefix}*")


def shrink(data: bytes) -> bytes | None:
    """Re-encode a poster, or None when the original is already the better file."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        return None
    if img.mode not in ("RGB", "L"):
        img = img.convert("RGB")
    img.thumbnail((MAX_EDGE, MAX_EDGE), Image.LANCZOS)
    out = io.BytesIO()
    img.save(out, format="JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
    encoded = out.getvalue()
    # Never replace a file with a larger one.
    return encoded if len(encoded) < len(data) else None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", default="dev")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    s3 = boto3.client("s3")
    bucket = resolve_bucket(s3, args.stage)
    print(f"bucket={bucket}{'  (DRY RUN)' if args.dry_run else ''}\n")

    posters_before = posters_after = 0
    shrunk = stamped = skipped = 0

    paginator = s3.get_paginator("list_objects_v2")
    for page in paginator.paginate(Bucket=bucket, Prefix="video/"):
        for obj in page.get("Contents", []):
            key, size = obj["Key"], obj["Size"]
            head = s3.head_object(Bucket=bucket, Key=key)
            has_header = head.get("CacheControl") == CACHE_CONTROL

            if key.endswith("poster.jpg"):
                posters_before += size
                if size > REWRITE_OVER_BYTES:
                    body = s3.get_object(Bucket=bucket, Key=key)["Body"].read()
                    encoded = shrink(body)
                    if encoded is None:
                        posters_after += size
                        skipped += 1
                        continue
                    posters_after += len(encoded)
                    shrunk += 1
                    print(
                        f"  {key}  {size / 1024:6.0f} KB -> {len(encoded) / 1024:6.0f} KB"
                        f"  (-{(1 - len(encoded) / size) * 100:2.0f}%)"
                    )
                    if not args.dry_run:
                        s3.put_object(
                            Bucket=bucket,
                            Key=key,
                            Body=encoded,
                            ContentType="image/jpeg",
                            CacheControl=CACHE_CONTROL,
                        )
                    continue
                posters_after += size

            # Header-only pass for everything not rewritten above.
            if not has_header:
                stamped += 1
                if not args.dry_run:
                    s3.copy_object(
                        Bucket=bucket,
                        Key=key,
                        CopySource={"Bucket": bucket, "Key": key},
                        MetadataDirective="REPLACE",
                        ContentType=head.get("ContentType", "binary/octet-stream"),
                        CacheControl=CACHE_CONTROL,
                    )

    print(
        f"\nposters {posters_before / 1e6:.0f} MB -> {posters_after / 1e6:.0f} MB"
        f"  ({shrunk} re-encoded, {skipped} left as-is)"
    )
    print(f"cache-control stamped on {stamped} object(s)")
    if args.dry_run:
        print("\ndry run — nothing written")
    return 0


if __name__ == "__main__":
    sys.exit(main())
