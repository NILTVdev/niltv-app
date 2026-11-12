"""Build the portal web app for a stage and publish it to its Amplify app.

    python portal/scripts/deploy.py --stage dev
    python portal/scripts/deploy.py --stage prod --confirm-prod
    python portal/scripts/deploy.py --stage prod --confirm-prod --check

Run from the repo root with AWS credentials. The API URL, user pool and
website client id come from the stage's CloudFormation outputs, so the build
always points at the stack that is actually deployed. The Amplify app is the
one named "niltv-portal"; branch dev serves portal-dev.niltv.com and branch
prod serves portal.niltv.com. Manual zip deploys, no Amplify build.

Prod ships only a clean tree whose HEAD is on origin/main. Every build
carries /version.json (commit, branch, build time, stage), so anyone can see
what is live. Before each deploy the app's response headers are set from
portal/customHttp.yml (app-level, so both branches get them). --check runs
the git gate and prints the version stamp without building or deploying.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIST = ROOT / "portal" / "dist"
HEADERS = ROOT / "portal" / "customHttp.yml"
APP_NAME = "niltv-portal"


def aws(*args: str) -> dict:
    out = subprocess.check_output(["aws", *args, "--output", "json"], text=True)
    return json.loads(out) if out.strip() else {}


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], cwd=ROOT, text=True).strip()


def check_prod_tree() -> None:
    """Refuse prod unless the tree is clean and HEAD is already on origin/main."""
    dirty = git("status", "--porcelain")
    if dirty:
        sys.exit("refusing prod: the working tree has uncommitted changes\n" + dirty)
    subprocess.check_call(["git", "fetch", "--quiet", "origin", "main"], cwd=ROOT)
    on_main = subprocess.call(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"], cwd=ROOT)
    if on_main != 0:
        sys.exit("refusing prod: HEAD is not on origin/main. Merge to main, pull, and deploy from there.")


def version_info(stage: str) -> dict[str, object]:
    return {
        "commit": git("rev-parse", "HEAD"),
        "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
        "dirty": bool(git("status", "--porcelain")),
        "builtAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "stage": stage,
    }


def stack_outputs(name: str) -> dict[str, str]:
    stacks = aws("cloudformation", "describe-stacks", "--stack-name", name)["Stacks"]
    return {o["OutputKey"]: o["OutputValue"] for o in stacks[0].get("Outputs", [])}


def app_id() -> str:
    for app in aws("amplify", "list-apps")["apps"]:
        if app["name"] == APP_NAME:
            return app["appId"]
    sys.exit(f"no Amplify app named {APP_NAME}")


def build(stage: str, version: dict[str, object]) -> None:
    foundation = stack_outputs(f"niltv-{stage}-foundation")
    portal = stack_outputs(f"niltv-{stage}-portal")
    env = {
        **os.environ,
        "VITE_PORTAL_API": portal["PortalApiUrl"],
        "VITE_COGNITO_POOL_ID": foundation["UserPoolId"],
        "VITE_COGNITO_CLIENT_ID": foundation["WebClientId"],
        "VITE_STAGE": stage,
    }
    print(f"building for {stage}: {env['VITE_PORTAL_API']}")
    if DIST.exists():
        shutil.rmtree(DIST)
    subprocess.check_call("npm run build -w @niltv/portal", cwd=ROOT, env=env, shell=True)
    if not (DIST / "index.html").exists():
        sys.exit("build produced no dist/index.html")
    (DIST / "version.json").write_text(json.dumps(version, indent=2) + "\n", encoding="utf-8")


def apply_headers(app: str) -> None:
    """Set the app-level custom headers from customHttp.yml when they differ."""
    wanted = HEADERS.read_text(encoding="utf-8").replace("\r\n", "\n")
    current = (aws("amplify", "get-app", "--app-id", app)["app"].get("customHeaders") or "").replace("\r\n", "\n")
    if current.strip() == wanted.strip():
        print("response headers: unchanged")
        return
    aws("amplify", "update-app", "--app-id", app, "--custom-headers", wanted)
    print("response headers: updated from portal/customHttp.yml")


def zip_dist() -> Path:
    path = Path(tempfile.mkdtemp()) / "portal.zip"
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for file in sorted(DIST.rglob("*")):
            if file.is_file():
                z.write(file, file.relative_to(DIST).as_posix())
    return path


def publish(app: str, branch: str, archive: Path) -> None:
    dep = aws("amplify", "create-deployment", "--app-id", app, "--branch-name", branch)
    req = urllib.request.Request(
        dep["zipUploadUrl"], data=archive.read_bytes(), method="PUT", headers={"Content-Type": "application/zip"}
    )
    with urllib.request.urlopen(req) as res:
        if res.status not in (200, 201):
            sys.exit(f"upload failed: HTTP {res.status}")
    aws("amplify", "start-deployment", "--app-id", app, "--branch-name", branch, "--job-id", dep["jobId"])
    for _ in range(60):
        job = aws("amplify", "get-job", "--app-id", app, "--branch-name", branch, "--job-id", dep["jobId"])
        status = job["job"]["summary"]["status"]
        if status in ("SUCCEED", "FAILED", "CANCELLED"):
            print(f"job {dep['jobId']}: {status}")
            if status != "SUCCEED":
                sys.exit(1)
            return
        time.sleep(5)
    sys.exit("timed out waiting for the Amplify job")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stage", choices=["dev", "prod"], required=True)
    parser.add_argument("--confirm-prod", action="store_true")
    parser.add_argument("--check", action="store_true", help="run the git gate and print the version stamp, then stop")
    args = parser.parse_args()
    if args.stage == "prod" and not args.confirm_prod:
        sys.exit("refusing prod without --confirm-prod")
    if args.stage == "prod":
        check_prod_tree()
    version = version_info(args.stage)
    print(json.dumps(version))
    if args.check:
        return
    build(args.stage, version)
    app = app_id()
    apply_headers(app)
    publish(app, args.stage, zip_dist())
    print("https://portal-dev.niltv.com/" if args.stage == "dev" else "https://portal.niltv.com/")


if __name__ == "__main__":
    main()
