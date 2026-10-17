#!/usr/bin/env python3
"""Build pristine pinned native solvers and retain source, command and binary receipts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parents[1]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tools-dir", type=Path, default=ROOT / ".cache/tools")
    parser.add_argument("--install-deps", action="store_true")
    args = parser.parse_args()
    tools = args.tools_dir.resolve()
    logs = tools / "logs" / (time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}")
    logs.mkdir(parents=True, exist_ok=True)
    lock_path = ROOT / "toolchain-lock.json"
    lock = json.loads(lock_path.read_text())
    env = dict(os.environ)
    env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + env.get("PATH", "")
    records = []

    def run(name, command, cwd=tools, check=True):
        started = time.time()
        result = subprocess.run(command, cwd=cwd, env=env, capture_output=True)
        stdout, stderr = logs / f"{name}.stdout.log", logs / f"{name}.stderr.log"
        stdout.write_bytes(result.stdout)
        stderr.write_bytes(result.stderr)
        records.append({"command": command, "cwd": str(cwd), "exitCode": result.returncode,
                        "wallSeconds": round(time.time() - started, 3),
                        "stdout": str(stdout), "stderr": str(stderr)})
        (tools / "commands.json").write_text(json.dumps(records, indent=2) + "\n")
        if check and result.returncode:
            raise RuntimeError(f"{name} failed ({result.returncode}); see {stderr} and {stdout}")
        return result.stdout.decode(errors="replace").strip()

    mac = platform.system() == "Darwin"
    if platform.system() not in ("Darwin", "Linux"):
        raise RuntimeError("Native setup supports macOS and Linux")
    if args.install_deps:
        if mac:
            run("dependencies", ["brew", "install", "cmake", "llvm", "libomp"])
        else:
            apt = ["apt-get"] if os.geteuid() == 0 else ["sudo", "apt-get"]
            run("apt-update", apt + ["update"])
            run("dependencies", apt + ["install", "-y", "build-essential", "git", "curl", "cmake", "bison", "flex"])
    for name in ["git", "curl", "make", "cmake", "cc", "c++"] + (["brew"] if mac else []):
        if not shutil.which(name, path=env["PATH"]):
            raise RuntimeError(f"Missing {name}; run setup-tools.py --install-deps")

    source_root = tools / "source"
    source_root.mkdir(exist_ok=True)
    provenance = {}

    def verify_git(name):
        checkout = source_root / name
        actual = run(f"{name}-commit", ["git", "rev-parse", "HEAD"], checkout)
        dirty = run(f"{name}-status", ["git", "status", "--porcelain", "--untracked-files=all", "--ignored"], checkout)
        if actual != lock["sources"][name]["commit"] or dirty:
            raise RuntimeError(f"{checkout} is not pristine at its pinned commit; use a fresh --tools-dir")
        provenance[name] = {"commit": actual, "tree": run(f"{name}-tree", ["git", "rev-parse", "HEAD^{tree}"], checkout),
                            "trackedDiff": ""}

    for name, source in lock["sources"].items():
        checkout = source_root / name
        if not checkout.exists():
            run(f"{name}-clone", ["git", "clone", "--no-checkout", source["url"], str(checkout)])
            run(f"{name}-checkout", ["git", "checkout", "--detach", source["commit"]], checkout)
        verify_git(name)

    def archive_source(name):
        source = lock[name]
        archive = tools / source["url"].rsplit("/", 1)[1]
        if not archive.exists():
            run(f"{name}-download", ["curl", "-L", "--fail", "--retry", "2", source["url"], "-o", str(archive)])
        if sha256(archive) != source["sha256"]:
            raise RuntimeError(f"Checksum mismatch: {archive}")
        directory = source_root / f"{name}-{source['version']}"
        manifest = hashlib.sha256()
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            for member in members:
                path = source_root / member.name
                target = path.parent / member.linkname if member.issym() else source_root / member.linkname
                if (not path.resolve().is_relative_to(source_root) or
                        (member.issym() or member.islnk()) and not target.resolve().is_relative_to(source_root)):
                    raise RuntimeError("Unsafe source archive path")
            if not directory.exists():
                tar.extractall(source_root)
            expected = set()
            for member in members:
                path = source_root / member.name
                if member.isfile() or member.islnk():
                    expected.add(path)
                    digest = hashlib.sha256(tar.extractfile(member).read()).hexdigest()
                    if not path.is_file() or path.is_symlink() or sha256(path) != digest:
                        raise RuntimeError(f"Modified archive source: {path}; use a fresh --tools-dir")
                    manifest.update(f"{member.name}\0{digest}\n".encode())
                elif member.issym():
                    expected.add(path)
                    if not path.is_symlink() or os.readlink(path) != member.linkname:
                        raise RuntimeError(f"Modified archive link: {path}; use a fresh --tools-dir")
                elif not member.isdir():
                    raise RuntimeError(f"Unsupported archive entry: {member.name}")
            actual = {path for path in directory.rglob("*") if not path.is_dir() or path.is_symlink()}
            if actual != expected:
                raise RuntimeError(f"Unexpected files in {directory}; use a fresh --tools-dir")
        provenance[name] = {"archiveSha256": source["sha256"], "sourceSha256": manifest.hexdigest()}
        return directory

    wx_source, ng_source = archive_source("wxWidgets"), archive_source("ngspice")
    # Never reuse objects from an older, potentially patched solver build.
    def fresh_build(name):
        directory = tools / name
        if directory.exists():
            shutil.rmtree(directory)
        directory.mkdir()
        return directory

    jobs = str(min(os.cpu_count() or 2, 4))
    compiler, cxx = "cc", "c++"
    cap_flags = ["-DCMAKE_POLICY_VERSION_MINIMUM=3.5", "-DCMAKE_CXX_STANDARD=11"]
    if mac:
        llvm = Path(run("llvm-prefix", ["brew", "--prefix", "llvm"]))
        omp = Path(run("libomp-prefix", ["brew", "--prefix", "libomp"]))
        compiler, cxx = str(llvm / "bin/clang"), str(llvm / "bin/clang++")
        cap_flags += [f"-DCMAKE_CXX_FLAGS=-I{omp}/include", f"-DCMAKE_EXE_LINKER_FLAGS=-L{omp}/lib"]
    wx_build, wx_prefix = fresh_build("wxwidgets-build"), tools / "wxwidgets-prefix"
    run("wxwidgets-configure", [str(wx_source / "configure"), f"--prefix={wx_prefix}", "--disable-gui",
                               "--disable-debug", "--enable-shared", "CXXFLAGS=-std=c++11"], wx_build)
    run("wxwidgets-build", ["make", "-j", jobs], wx_build)
    run("wxwidgets-install", ["make", "install"], wx_build)

    fh_build = fresh_build("fasthenry-build")
    shutil.copytree(source_root / "FastHenry2", fh_build, dirs_exist_ok=True, ignore=shutil.ignore_patterns(".git"))
    cflags = "-O2 -DFOUR -std=gnu89 -fcommon -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types"
    if mac:
        cflags += " -Wno-return-mismatch"
    run("fasthenry-build", ["make", "fasthenry", f"CC={compiler}", f"CFLAGS={cflags}"], fh_build)
    cap_build = fresh_build("fastercap-build")
    run("fastercap-configure", ["cmake", "-S", str(source_root / "FasterCap"), "-B", str(cap_build),
                              "-DCMAKE_BUILD_TYPE=Release", "-DFASTFIELDSOLVERS_HEADLESS=ON",
                              f"-DCMAKE_C_COMPILER={compiler}", f"-DCMAKE_CXX_COMPILER={cxx}",
                              f"-DwxWidgets_CONFIG_EXECUTABLE={wx_prefix / 'bin/wx-config'}", *cap_flags])
    run("fastercap-build", ["cmake", "--build", str(cap_build), "-j", jobs])
    ng_build, prefix = fresh_build("ngspice-build"), tools / "ngspice-prefix"
    run("ngspice-configure", [str(ng_source / "configure"), f"--prefix={prefix}", "--without-x",
                             "--with-readline=no", "--disable-openmp", "--disable-debug", "--enable-xspice"], ng_build)
    run("ngspice-build", ["make", "-j", jobs], ng_build)
    run("ngspice-install", ["make", "install"], ng_build)

    for name in lock["sources"]:
        verify_git(name)
    for name in ("wxWidgets", "ngspice"):
        archive_source(name)
    for path in (source_root / "FastHenry2").rglob("*"):
        relative = path.relative_to(source_root / "FastHenry2")
        if ".git" not in relative.parts and path.is_file() and sha256(path) != sha256(fh_build / relative):
            raise RuntimeError(f"Build changed FastHenry source: {relative}")
    paths = {"fasthenry": str(fh_build / "bin/fasthenry"), "fastercap": str(cap_build / "FasterCap"),
             "ngspice": str(prefix / "bin/ngspice")}
    versions = {"compiler": run("compiler-version", [compiler, "--version"]),
                "systemCompiler": run("system-compiler-version", ["cc", "--version"]),
                "cmake": run("cmake-version", ["cmake", "--version"]),
                "wxWidgets": run("wx-version", [str(wx_prefix / "bin/wx-config"), "--version"]),
                "fasthenry": run("fasthenry-version", [paths["fasthenry"], "-h"], check=False),
                "ngspice": run("ngspice-version", [paths["ngspice"], "--version"]),
                # Upstream headless main does not forward -bv; no-argument usage includes its version.
                "fastercap": run("fastercap-version", [paths["fastercap"]], check=False)}
    if not versions["fasthenry"]:
        versions["fasthenry"] = (logs / "fasthenry-version.stderr.log").read_text()
    receipt = {"host": platform.platform(), "architecture": platform.machine(), "lockSha256": sha256(lock_path),
               "sources": lock["sources"], "unmodifiedSources": True, "sourceProvenance": provenance,
               "versions": versions, "binarySha256": {k: sha256(Path(v)) for k, v in paths.items()}, "commands": records}
    (tools / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    (tools / "tools.json").write_text(json.dumps(paths, indent=2) + "\n")
    print(json.dumps(paths, indent=2))


if __name__ == "__main__":
    main()
