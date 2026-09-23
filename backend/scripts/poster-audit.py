"""
poster-audit — find and fix posters that do not fill the vertical frame.
(Twin of niltv-web/scripts/poster-audit.py, which the Deploy Prod workflow
runs hourly; keep the two identical.)

Ingest mirrors Instagram's cover image as poster.jpg. Creators often pick a
letterboxed cover (a 16:9 shot inside the 9:16 canvas with black bars), some
reposts ship a landscape cover, and a few posts have none. Every surface in
the app and on the site shows the poster in a 9:16 frame, so a poster with
bars, a landscape file, or no file at all reads as a broken card, even when
much of the video itself is full-bleed.

Rule: every clip has a poster.jpg that fills 9:16 with no bars.

    python scripts/poster-audit.py --stage prod            # audit, report only
    python scripts/poster-audit.py --stage prod --fix      # regenerate the bad ones
    python scripts/poster-audit.py --stage prod --fix --ids ig-XXXX
    python scripts/poster-audit.py --stage prod --since YYYY-MM-DD   # only newer clips

Audit: walks GET /v1/content for every channel on the stage CDN, downloads
each poster and flags it when it is missing, landscape, or letterboxed (black
rows across 12% or more of its height). Writes poster-audit-<stage>.json.

Fix: for each flagged id, downloads master.mp4 and scans a frame every
~200 ms for full-bleed frames (bars under 2% of height, not too dark, not in
the first or last half second). Scores by a detected face, sharpness and
brightness, writes the winner as poster.jpg at the video's own size, uploads
it with the immutable cache header and invalidates /video/{id}/* on the
stage's distribution (exact poster keys, chunks of 1000). When a clip is letterboxed
in every frame the fallback is the centre 9:16 crop of the picture band
(what the app's card would show anyway), logged as "cropped" so a human can
eyeball it.

Run it after every ingest and let it run daily. Dependencies (not part of the
npm workspace):

    pip install boto3 'opencv-python-headless<5' numpy
"""

from __future__ import annotations

import argparse
import io
import json
import sys
import tempfile
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass
from pathlib import Path

try:
    import boto3
    import cv2
    import numpy as np
except ModuleNotFoundError as exc:  # pragma: no cover - environment guard
    raise SystemExit(
        f"missing dependency: {exc.name}\n"
        "This script needs boto3, opencv-python-headless and numpy. In the\n"
        "interpreter you are running it with:\n\n"
        "    pip install boto3 opencv-python-headless numpy\n"
    ) from exc

STAGES = {
    "dev": {
        "cdn": "https://d1nm1d2txb83wa.cloudfront.net",
        "bucket": "niltv-dev-video-hls-858321320457",
        "distribution": "E23CTTFB3RV2CB",
    },
    "prod": {
        "cdn": "https://dr60jt51m7xh2.cloudfront.net",
        "bucket": "niltv-prod-video-hls-858321320457",
        "distribution": "E2VPOMST073ADA",
    },
}

CACHE_CONTROL = "public, max-age=31536000, immutable"
# A row whose mean luma is under this counts as a black bar row.
BAR_LUMA = 18
# Top + bottom bars covering this share of the height flag a poster.
LETTERBOX_FRAC = 0.12
# A candidate frame may carry at most this much bar (encoder edges).
FULL_BLEED_FRAC = 0.02
# Frames darker than this (mean luma) are fades, not posters.
MIN_LUMA = 35
JPEG_QUALITY = 88
SAMPLE_EVERY_SEC = 0.2
EDGE_SKIP_SEC = 0.5


@dataclass
class PosterCheck:
    channel_id: str
    content_id: str
    status: str  # ok | letterboxed | landscape | missing | error
    width: int = 0
    height: int = 0
    bar_top: int = 0
    bar_bottom: int = 0
    note: str = ""


def fetch(url: str, timeout: int = 60) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return response.read()


def bars(gray: np.ndarray, threshold: int = BAR_LUMA) -> tuple[int, int]:
    """Rows of near-black at the top and bottom of a grayscale frame."""
    rows = gray.mean(axis=1)
    top = 0
    while top < len(rows) and rows[top] < threshold:
        top += 1
    bottom = 0
    while bottom < len(rows) and rows[len(rows) - 1 - bottom] < threshold:
        bottom += 1
    return top, bottom


def list_content(cdn: str, since: str | None) -> list[tuple[str, str, str | None, str | None]]:
    channels = json.loads(fetch(f"{cdn}/v1/channels"))["channels"]
    items: list[tuple[str, str, str | None, str | None]] = []
    for channel in channels:
        cursor = None
        while True:
            url = f"{cdn}/v1/content?channelId={channel['id']}&limit=48"
            if cursor:
                url += f"&cursor={cursor}"
            page = json.loads(fetch(url))
            for item in page.get("items", []):
                published = item.get("publishedAt")
                if since and published and published < since:
                    continue
                items.append((channel["id"], item["id"], item.get("thumbUrl"), published))
            cursor = page.get("cursor")
            if not cursor:
                break
    return items


def check_poster(channel_id: str, content_id: str, thumb_url: str | None) -> PosterCheck:
    if not thumb_url:
        return PosterCheck(channel_id, content_id, "missing")
    try:
        data = np.frombuffer(fetch(thumb_url), dtype=np.uint8)
        image = cv2.imdecode(data, cv2.IMREAD_GRAYSCALE)
    except Exception as exc:  # network or decode
        return PosterCheck(channel_id, content_id, "error", note=str(exc)[:80])
    if image is None:
        return PosterCheck(channel_id, content_id, "error", note="undecodable")
    height, width = image.shape
    top, bottom = bars(image)
    if width > height:
        return PosterCheck(channel_id, content_id, "landscape", width, height, top, bottom)
    if (top + bottom) / height >= LETTERBOX_FRAC:
        return PosterCheck(channel_id, content_id, "letterboxed", width, height, top, bottom)
    return PosterCheck(channel_id, content_id, "ok", width, height, top, bottom)


def best_frame(video_path: str) -> tuple[np.ndarray | None, str]:
    """The best full-bleed frame, or the centre crop of the best letterboxed one."""
    # Face preference is a bonus, not a requirement: OpenCV 5 dropped the
    # legacy Haar cascades from the wheel, so score without faces when absent.
    face_model = None
    try:
        face_model = cv2.CascadeClassifier(cv2.data.haarcascades + "haarcascade_frontalface_default.xml")
        if face_model.empty():
            face_model = None
    except (AttributeError, cv2.error):
        face_model = None
    capture = cv2.VideoCapture(video_path)
    fps = capture.get(cv2.CAP_PROP_FPS) or 24.0
    frame_count = int(capture.get(cv2.CAP_PROP_FRAME_COUNT))
    height = int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))
    step = max(1, round(fps * SAMPLE_EVERY_SEC))
    edge = int(fps * EDGE_SKIP_SEC)

    best: tuple[float, np.ndarray] | None = None
    best_boxed: tuple[float, np.ndarray, int, int] | None = None
    index = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        if index % step == 0 and edge <= index <= max(edge, frame_count - edge):
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            top, bottom = bars(gray)
            # Brightness of the picture band, not the whole frame: a heavily
            # letterboxed clip is mostly black and would otherwise never
            # yield a candidate.
            band_gray = gray[top : gray.shape[0] - bottom] if top + bottom < gray.shape[0] else gray
            luma = float(band_gray.mean())
            if luma >= MIN_LUMA:
                sharp = float(cv2.Laplacian(band_gray, cv2.CV_64F).var())
                face_area = 0
                if face_model is not None:
                    faces = face_model.detectMultiScale(gray, 1.2, 5, minSize=(60, 60))
                    face_area = max((int(w) * int(h) for (_, _, w, h) in faces), default=0)
                score = (2.0 if face_area else 0.0) + min(sharp / 3000.0, 1.0) + luma / 255.0 * 0.3
                if (top + bottom) / height <= FULL_BLEED_FRAC:
                    if best is None or score > best[0]:
                        best = (score, frame)
                elif best_boxed is None or score > best_boxed[0]:
                    best_boxed = (score, frame, top, bottom)
        index += 1
    capture.release()

    if best is not None:
        return best[1], "full-bleed"
    if best_boxed is not None:
        _, frame, top, bottom = best_boxed
        band = frame[top : frame.shape[0] - bottom]
        band_h, band_w = band.shape[:2]
        crop_w = int(band_h * 9 / 16)
        if crop_w < band_w:
            left = (band_w - crop_w) // 2
            band = band[:, left : left + crop_w]
        return band, "cropped"
    return None, "no-usable-frame"


def fix_poster(stage: dict, check: PosterCheck, s3, workdir: Path) -> str:
    content_id = check.content_id
    video_path = workdir / f"{content_id}.mp4"
    video_path.write_bytes(fetch(f"{stage['cdn']}/video/{content_id}/master.mp4", timeout=300))
    frame, how = best_frame(str(video_path))
    video_path.unlink(missing_ok=True)
    if frame is None:
        return how
    ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
    if not ok:
        return "encode-failed"
    s3.put_object(
        Bucket=stage["bucket"],
        Key=f"video/{content_id}/poster.jpg",
        Body=encoded.tobytes(),
        ContentType="image/jpeg",
        CacheControl=CACHE_CONTROL,
    )
    return how


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stage", choices=STAGES, required=True)
    parser.add_argument("--fix", action="store_true", help="regenerate flagged posters from the video")
    parser.add_argument("--ids", nargs="*", help="only these content ids (skips the audit walk)")
    parser.add_argument("--since", help="only clips published on/after this ISO date")
    parser.add_argument("--workers", type=int, default=12)
    args = parser.parse_args()
    stage = STAGES[args.stage]

    if args.ids:
        items = [("?", content_id, f"{stage['cdn']}/video/{content_id}/poster.jpg", None) for content_id in args.ids]
    else:
        items = list_content(stage["cdn"], args.since)
    print(f"{args.stage}: {len(items)} clips to check")

    with ThreadPoolExecutor(args.workers) as pool:
        checks = list(pool.map(lambda it: check_poster(it[0], it[1], it[2]), items))
    flagged = [c for c in checks if c.status in ("letterboxed", "landscape", "missing")]
    errors = [c for c in checks if c.status == "error"]
    report_path = Path(f"poster-audit-{args.stage}.json")
    report_path.write_text(json.dumps([asdict(c) for c in checks], indent=1))

    by_status: dict[str, int] = {}
    for c in checks:
        by_status[c.status] = by_status.get(c.status, 0) + 1
    print("status counts:", by_status)
    for c in flagged:
        print(f"  {c.status:11s} {c.content_id} ({c.channel_id}) {c.width}x{c.height} bars {c.bar_top}/{c.bar_bottom}")
    for c in errors:
        print(f"  error       {c.content_id}: {c.note}")
    print(f"report: {report_path}")

    if not args.fix or not flagged:
        return 0

    s3 = boto3.client("s3")
    cloudfront = boto3.client("cloudfront")
    outcomes: dict[str, int] = {}
    paths: list[str] = []
    with tempfile.TemporaryDirectory() as tmp:
        workdir = Path(tmp)
        for c in flagged:
            try:
                how = fix_poster(stage, c, s3, workdir)
            except Exception as exc:
                how = f"failed: {str(exc)[:80]}"
            outcomes[how] = outcomes.get(how, 0) + 1
            print(f"  fixed {c.content_id}: {how}")
            if how in ("full-bleed", "cropped"):
                # Exact keys, never wildcards: CloudFront allows 3000 exact
                # paths in flight but only 15 wildcard invalidations, which a
                # batch fix easily exceeds.
                paths.append(f"/video/{c.content_id}/poster.jpg")
    for start in range(0, len(paths), 1000):
        chunk = paths[start : start + 1000]
        cloudfront.create_invalidation(
            DistributionId=stage["distribution"],
            InvalidationBatch={
                "Paths": {"Quantity": len(chunk), "Items": chunk},
                "CallerReference": f"poster-audit-{int(time.time())}-{start}",
            },
        )
        print(f"invalidated {len(chunk)} poster paths on {stage['distribution']}")
    print("fix outcomes:", outcomes)
    return 0


if __name__ == "__main__":
    sys.exit(main())
