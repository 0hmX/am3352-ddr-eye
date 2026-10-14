#!/usr/bin/env python3
"""Rebuild native experimental packages from pinned upstream source and local patches.

Use --prepare-locks only after intentionally changing build dependencies. The
ordinary mode verifies patch/build-input hashes, installs frozen dependencies,
and compares each normalized package against the manifest's expected SHA-256.
The browser worker has its own .packages/browser-runtime/rebuild.py command.
"""

import argparse
import base64
import gzip
import hashlib
import io
import json
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
PACKAGES = PROJECT / ".packages"
PATCHES = PACKAGES / "native-patches"
MANIFEST = PATCHES / "manifest.json"
ORDER = ("circuitJson", "props", "core")
DEFAULT_NAMES = {
    "circuitJson": "circuit-json-general-experimental.tgz",
    "props": "tscircuit-props-ibis-experimental.tgz",
    "core": "tscircuit-core-ibis-experimental.tgz",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def command(args, cwd=None, capture=False):
    print("+", " ".join(str(arg) for arg in args), flush=True)
    result = subprocess.run([str(arg) for arg in args], cwd=cwd, check=True,
                            text=True, stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def checked_path(value, root=PACKAGES):
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise RuntimeError("Build input escapes its source directory: " + value)
    return path


def verify(path, expected, label):
    if not re.fullmatch(r"[a-fA-F0-9]{64}", expected or ""):
        raise RuntimeError("Missing SHA-256 for " + label)
    if digest(path) != expected.lower():
        raise RuntimeError("Unexpected SHA-256 for " + label)


def normalized_tar(source, destination):
    """Canonical sorted files, POSIX modes, zero timestamps/owners and gzip time."""
    with tarfile.open(source) as archive:
        members = [item for item in archive.getmembers() if item.isfile()]
        if any(not item.name.startswith("package/") or ".." in Path(item.name).parts for item in members):
            raise RuntimeError("Unexpected package member in packed archive")
        if len({item.name for item in members}) != len(members):
            raise RuntimeError("Duplicate package archive member")
        with destination.open("wb") as output:
            with gzip.GzipFile(fileobj=output, mode="wb", mtime=0, filename="") as compressed:
                with tarfile.open(fileobj=compressed, mode="w") as canonical:
                    for item in sorted(members, key=lambda member: member.name):
                        contents = archive.extractfile(item).read()
                        entry = tarfile.TarInfo(item.name)
                        entry.size = len(contents)
                        entry.mode = 0o755 if item.mode & 0o111 else 0o644
                        entry.mtime = entry.uid = entry.gid = 0
                        entry.uname = entry.gname = ""
                        canonical.addfile(entry, io.BytesIO(contents))


def pack(source, destination, work):
    intermediate = work / (destination.name + ".npm.tgz")
    command(["bun", "pm", "pack", "--ignore-scripts", "--filename", intermediate, "--quiet"], cwd=source)
    normalized_tar(intermediate, destination)


def checkout(item, destination):
    commit = item.get("commit", "")
    if not re.fullmatch(r"[a-fA-F0-9]{40}", commit):
        raise RuntimeError("An exact 40-digit upstream commit is required")
    destination.mkdir()
    command(["git", "init", "--quiet"], cwd=destination)
    command(["git", "remote", "add", "origin", item["url"]], cwd=destination)
    command(["git", "fetch", "--quiet", "--depth=1", "origin", commit], cwd=destination)
    command(["git", "checkout", "--quiet", "--detach", "FETCH_HEAD"], cwd=destination)
    actual = command(["git", "rev-parse", "HEAD"], cwd=destination, capture=True)
    if actual.lower() != commit.lower():
        raise RuntimeError("Fetched upstream source differs from pinned commit")
    patch = checked_path(item["patch"])
    verify(patch, item.get("patchSha256"), "source patch " + item["patch"])
    command(["git", "apply", "--check", patch], cwd=destination)
    command(["git", "apply", patch], cwd=destination)


def install_build_environment(key, item, work, prepare):
    directory = work / (key + "-build")
    directory.mkdir()
    records = item.get("buildFiles", [])
    if not records:
        # During an intentional initial lock preparation, these are checked-in
        # exact-version dependency manifests. Ordinary rebuilds require hashes.
        if not prepare:
            raise RuntimeError("Missing frozen buildFiles for " + key + "; record package.json, pnpm-workspace.yaml and pnpm-lock.yaml with SHA-256")
        base = PATCHES / "build" / key
        records = [{"target": name, "path": str((base / name).relative_to(PACKAGES))}
                   for name in ("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml") if (base / name).exists()]
    targets = {record["target"] for record in records}
    if not {"package.json", "pnpm-workspace.yaml"}.issubset(targets) or (not prepare and "pnpm-lock.yaml" not in targets):
        raise RuntimeError("Incomplete native build environment for " + key)
    for record in records:
        source = checked_path(record["path"])
        if not prepare:
            verify(source, record.get("sha256"), key + "/" + record["target"])
        target = (directory / record["target"]).resolve()
        if not target.is_relative_to(directory):
            raise RuntimeError("Build file target escapes environment")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    if prepare and (directory / "pnpm-lock.yaml").exists():
        # Intentional local-package changes can retain the same version/name.
        # Update only their byte integrity, preserving all existing registry and
        # Git dependency versions instead of discarding the dependency lock.
        lock = directory / "pnpm-lock.yaml"
        pattern = re.compile(r"(resolution:\s*\{integrity:\s*)sha512-[A-Za-z0-9+/=]+(,\s*tarball:\s*file:([^}\s]+)\s*\})")
        def refresh(match):
            archive = (directory / match[3]).resolve()
            if not archive.is_relative_to(work / ".packages"):
                raise RuntimeError("Local build archive escapes the staged package directory")
            integrity = base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
            return match[1] + "sha512-" + integrity + match[2]
        lock.write_text(pattern.sub(refresh, lock.read_text()))
    command(["pnpm", "install", "--no-frozen-lockfile" if prepare else "--frozen-lockfile", "--ignore-scripts"], cwd=directory)
    if prepare:
        destination = PATCHES / "build" / key
        destination.mkdir(parents=True, exist_ok=True)
        for name in ("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml"):
            shutil.copyfile(directory / name, destination / name)
        records = [{"target": name, "path": str((destination / name).relative_to(PACKAGES)), "sha256": digest(destination / name)}
                   for name in ("package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml")]
    return directory, records


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare-locks", action="store_true", help="Generate frozen build locks after intentional dependency changes; print proposed manifest inputs without editing its manifest")
    parser.add_argument("--output-directory", type=Path, help="Stage rebuilt files here; defaults to .packages after expected-hash verification")
    parser.add_argument("--keep-work", action="store_true", help="Keep clones/build environments under .tscircuit/rebuild for inspection")
    args = parser.parse_args()
    manifest = json.loads(MANIFEST.read_text())
    for executable in ("git", "bun", "pnpm", "node"):
        if not shutil.which(executable):
            raise RuntimeError("Required build executable is unavailable: " + executable)
    if not (PROJECT / "node_modules").exists():
        raise RuntimeError("Run pnpm install --frozen-lockfile in the project first")
    rebuild = PROJECT / ".tscircuit" / "rebuild"
    rebuild.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="native-", dir=rebuild))
    output = (args.output_directory or PACKAGES).resolve()
    output.mkdir(parents=True, exist_ok=True)
    report = {"buildInputs": {}, "artifacts": {}, "workDirectory": str(work), "outputDirectory": str(output), "verified": not args.prepare_locks}
    succeeded = False
    try:
        local_packages = work / ".packages"
        local_packages.mkdir()
        for path in PACKAGES.glob("*.tgz"):
            shutil.copyfile(path, local_packages / path.name)
        converter = PROJECT / "packages" / "ibis-to-spice"
        command(["pnpm", "--filter", "@tscircuit/ibis-to-spice", "build"], cwd=PROJECT)
        converter_info = json.loads((converter / "package.json").read_text())
        converter_name = manifest.get("converter", {}).get("filename", "ibis-to-spice-" + converter_info["version"] + ".tgz")
        pack(converter, local_packages / converter_name, work)
        converter_hash = digest(local_packages / converter_name)
        if not args.prepare_locks:
            verify(local_packages / converter_name, manifest.get("converter", {}).get("sha256"), "workspace converter artifact")
        report["artifacts"]["converter"] = {"filename": converter_name, "sha256": converter_hash}
        for key in ORDER:
            item = manifest[key]
            source = work / key
            checkout(item, source)
            environment, records = install_build_environment(key, item, work, args.prepare_locks)
            (source / "node_modules").symlink_to(environment / "node_modules", target_is_directory=True)
            # Package binaries are resolved from this environment while Bun
            # keeps TS-only solver dependencies executable during compilation.
            build = item.get("buildCommand", ["bun", "run", "build"])
            if not isinstance(build, list) or not all(isinstance(value, str) for value in build):
                raise RuntimeError("buildCommand must be an argument array")
            command(build, cwd=source)
            name = item.get("filename", DEFAULT_NAMES[key])
            destination = local_packages / name
            pack(source, destination, work)
            if not args.prepare_locks:
                verify(destination, item.get("sha256"), "rebuilt " + key + " artifact")
            report["buildInputs"][key] = records
            report["artifacts"][key] = {"filename": name, "sha256": digest(destination)}
        # Copy only after every package has passed verification, avoiding an
        # incomplete replacement of the working project's experimental runtime.
        for item in report["artifacts"].values():
            shutil.copyfile(local_packages / item["filename"], output / item["filename"])
        report_path = rebuild / "last-rebuild.json"
        report_path.write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(report, indent=2))
        succeeded = True
    finally:
        if succeeded and not args.keep_work:
            shutil.rmtree(work)
        elif not succeeded:
            print("Build failed; inspection files retained at", work)


if __name__ == "__main__":
    main()
