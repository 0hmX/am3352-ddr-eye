#!/usr/bin/env python3
"""Build pinned native solvers; retain source, patch, command and binary receipts."""
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
    if args.install_deps:
        if mac:
            run("dependencies", ["brew", "install", "cmake", "wxwidgets", "libomp"])
        elif platform.system() == "Linux":
            apt = ["apt-get"] if os.geteuid() == 0 else ["sudo", "apt-get"]
            run("apt-update", apt + ["update"])
            run("dependencies", apt + ["install", "-y", "build-essential", "git", "curl", "cmake",
                                        "libwxgtk3.2-dev", "bison", "flex"])
        else:
            raise RuntimeError("Native setup supports macOS and Linux")
    for name in ["git", "curl", "make", "cmake", "wx-config", "cc", "c++"]:
        if not shutil.which(name, path=env["PATH"]):
            raise RuntimeError(f"Missing {name}; run setup-tools.py --install-deps")

    source_root = tools / "source"
    source_root.mkdir(exist_ok=True)
    for name, source in lock["sources"].items():
        checkout = source_root / name
        if not checkout.exists():
            run(f"{name}-clone", ["git", "clone", "--no-checkout", source["url"], str(checkout)])
            run(f"{name}-checkout", ["git", "checkout", "--detach", source["commit"]], checkout)
        actual = run(f"{name}-commit", ["git", "rev-parse", "HEAD"], checkout)
        if actual != source["commit"]:
            raise RuntimeError(f"{checkout} is at {actual}, expected {source['commit']}; use a fresh --tools-dir")

    def replace(path, old, new):
        text = path.read_bytes().decode()
        if new in text:
            return
        if old in text:
            path.write_bytes(text.replace(old, new, 1).encode())
        else:
            raise RuntimeError(f"Patch no longer applies: {path}")

    cap = source_root / "FasterCap"
    cmake_file = cap / "CMakeLists.txt"
    replace(cmake_file, "cmake_minimum_required (VERSION 2.8)", "cmake_minimum_required (VERSION 3.10)")
    replace(cmake_file, "set(wxWidgets_CONFIG_OPTIONS --version=3.0 --static=no",
            "set(wxWidgets_CONFIG_OPTIONS --static=no")
    replace(cap / "Solver/AutoSegment.cpp", "normal = lNormal;", "normal = leftSubPanel->GetGeoNormal();")
    replace(cap / "FasterCapConsole.cpp", '#include "FasterCapConsole.h"',
            '#include "FasterCapConsole.h"\n#include <wx/init.h>')
    console = cap / "FasterCapConsole.cpp"
    if b"wxInitializer initializer;" not in console.read_bytes():
        replace(console, "FasterCapConsole console;",
                "wxInitializer initializer;\n    if (!initializer.IsOk()) return 1;\n    FasterCapConsole console;")
    replace(console, "ret = console.main(argc, argv);",
            "char bOption = 0;\n    for (int i = 1; i < argc; ++i)\n"
            "        if (argv[i][0] == '-' && argv[i][1] == 'b') bOption = argv[i][2];\n"
            "    ret = console.main(argc, argv, bOption);")
    if mac:
        omp_prefix = run("libomp-prefix", ["brew", "--prefix", "libomp"])
        replace(cmake_file, "-Wextra -Wall -fopenmp)",
                f"-Wextra -Wall -Xpreprocessor -fopenmp -I{omp_prefix}/include)")
        replace(cmake_file, " -fopenmp -lm -lstdc++", f" -lm -L{omp_prefix}/lib -lomp")
    patch = run("FasterCap-patch", ["git", "diff", "--no-ext-diff"], cap)
    (tools / "FasterCap.patch").write_text(patch + "\n")

    compiler = "clang" if mac else "cc"
    cflags = "-O2 -DFOUR -std=gnu89 -fcommon -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types"
    if mac:
        cflags += " -Wno-return-mismatch"
    run("fasthenry-build", ["make", "fasthenry", f"CC={compiler}", f"CFLAGS={cflags}"], source_root / "FastHenry2")
    cap_build = tools / "fastercap-build"
    run("fastercap-configure", ["cmake", "-S", str(cap), "-B", str(cap_build),
                              "-DCMAKE_BUILD_TYPE=Release", "-DFASTFIELDSOLVERS_HEADLESS=ON",
                              f"-DwxWidgets_CONFIG_EXECUTABLE={shutil.which('wx-config', path=env['PATH'])}"])
    run("fastercap-build", ["cmake", "--build", str(cap_build), "-j", str(min(os.cpu_count() or 2, 4))])

    ng = lock["ngspice"]
    archive = tools / f"ngspice-{ng['version']}.tar.gz"
    if not archive.exists():
        run("ngspice-download", ["curl", "-L", "--fail", "--retry", "2", ng["url"], "-o", str(archive)])
    if sha256(archive) != ng["sha256"]:
        raise RuntimeError(f"Checksum mismatch: {archive}")
    ng_source = source_root / f"ngspice-{ng['version']}"
    if not ng_source.exists():
        with tarfile.open(archive) as tar:
            for member in tar.getmembers():
                if not (source_root / member.name).resolve().is_relative_to(source_root.resolve()):
                    raise RuntimeError("Unsafe source archive path")
            tar.extractall(source_root)
    ng_build, prefix = tools / "ngspice-build", tools / "ngspice-prefix"
    ng_build.mkdir(exist_ok=True)
    run("ngspice-configure", [str(ng_source / "configure"), f"--prefix={prefix}", "--without-x",
                             "--with-readline=no", "--disable-openmp", "--disable-debug", "--enable-xspice"], ng_build)
    run("ngspice-build", ["make", "-j", str(min(os.cpu_count() or 2, 4))], ng_build)
    run("ngspice-install", ["make", "install"], ng_build)

    paths = {"fasthenry": str(source_root / "FastHenry2/bin/fasthenry"),
             "fastercap": str(cap_build / "FasterCap"), "ngspice": str(prefix / "bin/ngspice")}
    versions = {"compiler": run("compiler-version", [compiler, "--version"]),
                "cmake": run("cmake-version", ["cmake", "--version"]),
                "wxWidgets": run("wx-version", ["wx-config", "--version"]),
                "fasthenry": run("fasthenry-version", [paths["fasthenry"], "-h"], check=False),
                "ngspice": run("ngspice-version", [paths["ngspice"], "--version"])}
    versions["fastercap"] = run("fastercap-version", [paths["fastercap"], "-bv"])
    if not versions["fasthenry"]:
        versions["fasthenry"] = (logs / "fasthenry-version.stderr.log").read_text()
    (tools / "tools.json").write_text(json.dumps(paths, indent=2) + "\n")
    receipt = {"host": platform.platform(), "architecture": platform.machine(), "lockSha256": sha256(lock_path),
               "sources": lock["sources"], "versions": versions, "binarySha256": {k: sha256(Path(v)) for k, v in paths.items()},
               "patchSha256": sha256(tools / "FasterCap.patch"), "commands": records}
    (tools / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(paths, indent=2))


if __name__ == "__main__":
    main()
