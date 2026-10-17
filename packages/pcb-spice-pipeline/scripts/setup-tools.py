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
    # Preserve PCB features and panel centroids across the whole-board coordinate
    # range. Upstream's float storage can round a thin triangle centroid onto
    # an edge, producing zero self potential and NaN Krylov iterations.
    geometry_headers = source_root / "Geometry"
    replace(geometry_headers / "Vector3D_float.h", "#define C3DVector_float_type\tfloat",
            "#define C3DVector_float_type\tdouble")
    for header in ["Vector3D.h", "Vector3D_float.h"]:
        path = geometry_headers / header
        path.write_bytes(path.read_bytes().replace(b"(float)", b"(C3DVector_float_type)"))
    replace(cap / "Solver/Autorefine.cpp", "float x, y, z, localOutperm[2], localInperm[2], tmpperm;",
            "double x, y, z; float localOutperm[2], localInperm[2], tmpperm;")
    parser_source = cap / "Solver/Autorefine.cpp"
    parser_source.write_bytes(parser_source.read_bytes().replace(b'"%f%f%f%n"', b'"%lf%lf%lf%n"'))
    replace(parser_source, "if( *potestRe == 0.0) {", """if( *potestRe == 0.0) {
                ErrMsg("Error: zero conductor self-potential; refusing a nonfinite solve\\n");
                panel->ErrorPrintCoords(); std::cout.flush(); exit(1);""")
    panel_source = cap / "Solver/AutoPanel.cpp"
    panel_source.write_bytes(panel_source.read_bytes().replace(b"%g", b"%.17g"))
    potential_source = cap / "Solver/Potential.cpp"
    potential = potential_source.read_bytes()
    potential = potential.replace(
        b"if (P0/lmax > POTENTIAL_GEO_EPS && fabs((Rmp_norm[j]+lplus)/lmax) > POTENTIAL_GEO_EPS && fabs((Rmp_norm[i]+lminus)/lmax) > POTENTIAL_GEO_EPS)",
        b"if (P0 > 0.0)")
    potential = potential.replace(
        b"ln = log((Rmp_norm[j]+lplus)/(Rmp_norm[i]+lminus));",
        b"ln = asinh(lplus/R0) - asinh(lminus/R0); /* stable edge integral */")
    potential_source.write_bytes(potential)
    krylov_source = cap / "Solver/SolveCapacitance.cpp"
    krylov_source.write_bytes(krylov_source.read_bytes().replace(
        b"dot_prod(m_pclsGmres_q[j], m_clsGmres_w)",
        b"dot_prod(m_pclsGmres_q[j], m_clsGmres_v) /* modified Gram-Schmidt */"))
    krylov = krylov_source.read_bytes()
    for function in [b"gmresPrecondSFastAll", b"gmresFlexPrecondSFastAll"]:
        start = krylov.index(b"int CSolveCap::"+function+b"(")
        end = krylov.index(b"int CSolveCap::", start+20)
        body = krylov[start:end]
        if b"Reject an initial guess worse than zero" in body:
            continue
        body = body.replace(b"normb = mod(*b);", b"""normb = mod(*b);
        /* Reject an initial guess worse than zero in the actual residual. */
        if (normr > normb) {
            LogMsg("Discarding inaccurate initial guess; using zero-start\\n");
            m_clsGmres_x0 = CLin_Vector(size, 0.0);
            m_clsGmres_r = *b;
            normr = normb;
        }""", 1)
        krylov = krylov[:start]+body+krylov[end:]
    # Check the actual equation after reconstructing the solution. The recursive
    # Arnoldi residual alone does not establish that the computed charges solve it.
    for function in [b"gmresPrecondSFastAll", b"gmresFlexPrecondSFastAll"]:
        start = krylov.index(b"int CSolveCap::"+function+b"(")
        end = krylov.index(b"int CSolveCap::", start+20)
        body = krylov[start:end]
        if b"Explicit relative residual" in body:
            continue
        location = body.rindex(b"return FC_NORMAL_END;")
        check = b"""retInt = m_clsMulthier.MultiplyMatByVec_fast(&m_clsGmres_v, x);
    if (retInt != FC_NORMAL_END) return retInt;
    for (ii=0; ii<size; ii++) m_clsGmres_r[ii] = (*b)[ii] - m_clsGmres_v[ii];
    double explicitResidual = mod(m_clsGmres_r) / normb;
    LogMsg("Explicit relative residual: %.17g; target: %.17g\\n", explicitResidual, gmresTol);
    if (!isfinite(explicitResidual) || explicitResidual > gmresTol * (1.0 + 1e-6)) {
        ErrMsg("Error: explicit residual check failed\\n");
        return FC_GENERIC_ERROR;
    }
    """
        body = body[:location]+check+body[location:]
        krylov = krylov[:start]+body+krylov[end:]
    krylov_source.write_bytes(krylov)
    cmake_file = cap / "CMakeLists.txt"
    replace(cmake_file, "cmake_minimum_required (VERSION 2.8)", "cmake_minimum_required (VERSION 3.10)")
    replace(cmake_file, "set(wxWidgets_CONFIG_OPTIONS --version=3.0 --static=no",
            "set(wxWidgets_CONFIG_OPTIONS --static=no")
    replace(cap / "Solver/AutoSegment.cpp", "normal = lNormal;", "normal = leftSubPanel->GetGeoNormal();")
    messages = cap / "FasterCapGlobal.cpp"
    messages.write_bytes(messages.read_bytes().replace(b"std::cout << msg;", b"std::cout << msg << std::flush;"))
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
    patch = run("Geometry-patch", ["git", "diff", "--no-ext-diff"], geometry_headers)
    (tools / "Geometry.patch").write_text(patch + "\n")

    compiler = "clang" if mac else "cc"
    henry = source_root / "FastHenry2/src/fasthenry"
    shutil.copyfile(ROOT / "scripts/fh-far-mutual.h", henry / "fh-far-mutual.h")
    makefile = henry / "Makefile"
    if "mutual.o: fh-far-mutual.h" not in makefile.read_text():
        makefile.write_text(makefile.read_text() + "\nmutual.o: fh-far-mutual.h\n")
    replace(henry / "mutual.c", '#include "induct.h"',
            '#include "induct.h"\n#include "fh-far-mutual.h"')
    replace(henry / "mutual.c", "  scaleEPS = minR/maxlength*10;", """  /* Avoid cancellation of endpoint-distance differences for short distant
     filaments. The quadrature retains orientation and reciprocity. */
  if (minR > 4*maxlength) {
    double a[3], da[3], b[3], db[3];
    int k;
    a[0]=fil1->x[0]; a[1]=fil1->y[0]; a[2]=fil1->z[0];
    b[0]=fil2->x[0]; b[1]=fil2->y[0]; b[2]=fil2->z[0];
    da[0]=fil1->x[1]-a[0]; da[1]=fil1->y[1]-a[1]; da[2]=fil1->z[1]-a[2];
    db[0]=fil2->x[1]-b[0]; db[1]=fil2->y[1]-b[1]; db[2]=fil2->z[1]-b[2];
    return fh_far_mutual(a, da, b, db);
  }
  scaleEPS = minR/maxlength*10;""")
    # Stable closest-line geometry and conditioned near-parallel integration.
    # The native regression also fails against the original executable.
    shutil.copyfile(ROOT / "scripts/fh-near-parallel.h", henry / "fh-near-parallel.h")
    if "mutual.o: fh-near-parallel.h" not in makefile.read_text():
        makefile.write_text(makefile.read_text() + "\nmutual.o: fh-near-parallel.h\n")
    if "Endpoint-vector geometry avoids cancellation" not in (henry / "mutual.c").read_text():
        run("FastHenry-stable-lines-patch", ["git", "apply", "--directory=src/fasthenry",
            str(ROOT / "scripts/fh-stable-lines.patch")], source_root / "FastHenry2")
    replace(henry / "joelself.c", "fabs(fabs(l3 - l3_1) - l2)/l2 > EPS",
            "fabs(fabs(l3 - l3_1) - l2) > EPS*l2 + 64*2.220446049250313e-16*(l2 + fabs(fil_m->x[0]) + fabs(fil_m->y[0]) + fabs(fil_m->z[0]) + fabs(fil_j->x[0]) + fabs(fil_j->y[0]) + fabs(fil_j->z[0]))")
    paths = henry / "findpaths.c"
    traversal = paths.read_text()
    if "static void enqueue_tree_node" not in traversal:
        helper = """static void enqueue_tree_node(NODES *node, NPATH **head, NPATH **tail)
{
  NPATH *item = (NPATH *)Gmalloc(sizeof(NPATH));
  item->node = node; item->next = NULL;
  if (*head == NULL) *head = item;
  else (*tail)->next = item;
  *tail = item;
}

"""
        start = traversal.index("make_trees(indsys)")
        end = traversal.index("\n}\n", start) + 3
        body = traversal[start:end].replace("NPATH *stack = NULL;", "NPATH *stack = NULL, *tail = NULL;")
        body = body.replace("push_node(node, &stack);", "enqueue_tree_node(node, &stack, &tail);")
        body = body.replace("push_node(other, &stack);", "enqueue_tree_node(other, &stack, &tail);")
        paths.write_text(traversal[:start] + helper + body + traversal[end:])
    traversal = paths.read_text()
    if "Lowest common ancestor closes either spanning-tree traversal" not in traversal:
        start = traversal.index("make_loop(node_l, node_s, seg, tree)")
        end = traversal.index("\n}\n", start) + 3
        body = """make_loop(node_l, node_s, seg, tree)
NODES *node_l, *node_s;
seg_ptr seg;
TREE *tree;
{
  /* Lowest common ancestor closes either spanning-tree traversal. */
  SPATH *path = add_seg_to_list(seg, NULL);
  SPATH *right = NULL, *tail = NULL, *item;
  NODES *left_node = node_l, *right_node = node_s;
  while (left_node != right_node) {
    if (left_node->level >= right_node->level) {
      path = add_seg_to_list(left_node->pred, path);
      left_node = getrealnode(getothernode(left_node, left_node->pred));
    } else {
      item = add_seg_to_list(right_node->pred, NULL);
      if (tail == NULL) right = item;
      else tail->next = item;
      tail = item;
      right_node = getrealnode(getothernode(right_node, right_node->pred));
    }
  }
  for (item = path; item->next != NULL; item = item->next) {}
  item->next = right;
  tree->loops = add_path_to_list(path, tree->loops);
  tree->number_of_loops += 1;
}
"""
        paths.write_text(traversal[:start] + body + traversal[end:])
    patch = run("FastHenry-patch", ["git", "diff", "--no-ext-diff"], henry.parent.parent)
    (tools / "FastHenry.patch").write_text(patch + "\n")
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
               "patchSha256": sha256(tools / "FasterCap.patch"),
               "fastHenryPatchSha256": sha256(tools / "FastHenry.patch"),
               "fastHenryQuadratureSha256": sha256(henry / "fh-far-mutual.h"),
               "fastHenryNearParallelSha256": sha256(henry / "fh-near-parallel.h"),
               "fastHenryStableLinesPatchSha256": sha256(ROOT / "scripts/fh-stable-lines.patch"), "commands": records}
    receipt["geometryPatchSha256"] = sha256(tools / "Geometry.patch")
    (tools / "build-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps(paths, indent=2))


if __name__ == "__main__":
    main()
