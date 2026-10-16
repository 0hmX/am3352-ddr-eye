"""Field-solver decks from the existing circuit-json-to-gmsh physical model.

Coordinates stay in PCB world mm until the final SI deck serialization. No
trace straightening or invented parallel return strip is used here. The
resulting whole-route quasistatic matrices are still homogenized downstream.
"""
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import gmsh
import numpy as np
from shapely import set_precision
from shapely.geometry import Point, Polygon, box


def progress(message):
    print(message, flush=True)


def mesh_capacitance_foils(regions, settings, output):
    """Mesh saved boundaries directly instead of bisecting skinny triangles.

    Boundary nodes remain constrained. The size floor limits grading into tiny
    polygon details; it does not remove or move those boundary details.
    """
    from planar import nonempty_polygons
    maximum = settings["maximumPanelLengthMm"]
    minimum = min(maximum, settings["coordinateGridMm"] * 10)
    gmsh.initialize()
    gmsh.option.setNumber("General.Verbosity", 1)
    gmsh.option.setNumber("General.NumThreads", 1)
    gmsh.option.setNumber("Mesh.RandomSeed", 1)
    gmsh.model.add("saved-capacitance-copper")
    points, surfaces = {}, {}
    for label, shape, z in regions:
        for polygon in nonempty_polygons(shape):
            rings = []
            for ring in [polygon.exterior, *polygon.interiors]:
                tags = []
                for x, y in list(ring.coords)[:-1]:
                    key = tuple(round(float(q), 9) for q in [x, y, z])
                    if key not in points:
                        points[key] = gmsh.model.geo.addPoint(*key, maximum)
                    tags.append(points[key])
                lines = [gmsh.model.geo.addLine(a, b) for a, b in zip(tags, tags[1:] + tags[:1])]
                rings.append(gmsh.model.geo.addCurveLoop(lines))
            surfaces[gmsh.model.geo.addPlaneSurface(rings)] = label
    gmsh.model.geo.synchronize()
    gmsh.option.setNumber("Mesh.Algorithm", 6)
    gmsh.option.setNumber("Mesh.MeshSizeMax", maximum)
    gmsh.option.setNumber("Mesh.MeshSizeMin", minimum)
    gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
    gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
    gmsh.model.mesh.generate(2)
    gmsh.model.mesh.optimize("Relocate2D")
    tags, xyz, _ = gmsh.model.mesh.getNodes()
    positions = dict(zip(map(int, tags), np.asarray(xyz).reshape(-1, 3)))
    panels = defaultdict(list)
    for surface, label in surfaces.items():
        kinds, _, elements = gmsh.model.mesh.getElements(2, surface)
        if list(kinds) != [2]:
            raise ValueError("Capacitance foil mesh must contain triangles")
        panels[label].extend(np.array([positions[int(tag)] for tag in triangle]) for triangle in np.asarray(elements[0]).reshape(-1, 3))
    gmsh.write(str(output / "capacitance-foil-mesh.msh"))
    gmsh.finalize()
    return panels, {"meshTargetMm": maximum, "meshSizeFloorMm": minimum}


def vertical_panels(shape, lower_mm, upper_mm, maximum_mm):
    polygons = [shape] if shape.geom_type == "Polygon" else getattr(shape, "geoms", [])
    for polygon in polygons:
        if polygon.geom_type != "Polygon":
            continue
        for ring in [polygon.exterior, *polygon.interiors]:
            for a, b in zip(ring.coords, list(ring.coords)[1:]):
                a, b = np.array(a), np.array(b)
                count = max(1, math.ceil(np.linalg.norm(b - a) / maximum_mm))
                for i in range(count):
                    left, right = a + (b - a) * i / count, a + (b - a) * (i + 1) / count
                    yield np.array([[*left, lower_mm], [*right, lower_mm], [*right, upper_mm]])
                    yield np.array([[*left, lower_mm], [*right, upper_mm], [*left, upper_mm]])


def panel_line(label, xyz_mm, reference_mm=None):
    coordinates = (xyz_mm / 1000).flat
    if reference_mm is not None:
        coordinates = [*coordinates, *(np.asarray(reference_mm) / 1000)]
    return "T " + label + " " + " ".join(f"{q:.12g}" for q in coordinates) + "\n"


def write_capacitance(options):
    """Saved copper outlines as zero-thickness sheets in a homogeneous dielectric.

    This reuses the existing pipeline's effective-permittivity approximation.
    No claim of a converged layered-dielectric boundary solve is made.
    """
    model, board, copper, context, output = [options[k] for k in ["model", "board", "copper", "context", "output"]]
    labels = {signal["from"]["netId"]: f"SIG{i}" for i, signal in enumerate(context["signals"])}
    references = {ref["from"]["netId"] for ref in context["returns"]}
    settings = context["settings"]
    maximum = settings["maximumPanelLengthMm"]
    regions = []
    for foil in model["multilayer"]["stackup"]["copperLayers"]:
        z = (foil["zMin"]+foil["zMax"])/2
        for net, shape in copper[foil["name"]].items():
            label = labels.get(net, "REF" if net in references else None)
            if label is None:
                raise ValueError("Unselected copper entered capacitance export")
            shape = set_precision(shape, settings["coordinateGridMm"])
            regions.append((label, shape, z))
    panels, mesh = mesh_capacitance_foils(regions, settings, output)
    # Keep barrel panels from spanning the whole board thickness. On this board
    # the former 1.5mm-by-0.017mm panels caused severe conditioning problems.
    barrel_length = maximum * 0.6
    barrel_boundary_error = 0.0
    for barrel in model["multilayer"]["barrels"]:
        label = labels.get(barrel["netId"], "REF" if barrel["netId"] in references else None)
        if label is None:
            raise ValueError("Unselected barrel entered capacitance export")
        original_shell = Polygon([(p["x"], p["y"]) for p in barrel["hole"]]).buffer(barrel["platingThickness"]/2, join_style="mitre")
        shell = original_shell.simplify(settings["surfaceToleranceMm"], preserve_topology=True)
        error = original_shell.hausdorff_distance(shell)
        if error > settings["surfaceToleranceMm"]:
            raise ValueError("Barrel simplification exceeded the declared surface tolerance")
        barrel_boundary_error = max(barrel_boundary_error, error)
        levels = np.linspace(barrel["zMin"], barrel["zMax"], math.ceil((barrel["zMax"] - barrel["zMin"]) / barrel_length) + 1)
        for lower, upper in zip(levels, levels[1:]):
            panels[label].extend(vertical_panels(shell, lower, upper, maximum))
    permittivity = context["settings"]["homogeneousRelativePermittivity"]
    lines = ["* Saved foil midplanes and barrel shells; homogeneous dielectric; coordinates in metres\n"]
    for label in [*labels.values(), "REF"]:
        if not panels[label]:
            raise ValueError(f"No surface panels for {label}")
        filename = f"{label}.txt"
        (output / filename).write_text("* physical conductor surface\n" + "".join(panel_line(label, tri) for tri in panels[label]))
        lines.append(f"C {filename} {permittivity} 0 0 0\n")
    (output / "channel.lst").write_text("".join(lines))
    triangles = np.asarray([triangle for group in panels.values() for triangle in group])
    edges = np.roll(triangles, -1, axis=1) - triangles
    lengths = np.linalg.norm(edges, axis=2)
    angles = np.arccos(np.clip(np.sum(-np.roll(edges, 1, axis=1) * edges, axis=2) / (np.roll(lengths, 1, axis=1) * lengths), -1, 1)) * 180 / np.pi
    return {"conductorPanels": len(triangles), "dielectricPanels": 0, "geometry": "thin-sheets", "homogeneousRelativePermittivity": permittivity, "conductorOrder": [*labels.values(), "REF"], **mesh, "barrelPanelLengthMm": barrel_length, "maximumBarrelBoundaryErrorMm": barrel_boundary_error, "maximumPanelEdgeMm": float(lengths.max()), "minimumAngleDegrees": float(angles.min()), "panelsBelowFiveDegrees": int(np.sum(angles.min(axis=1) < 5))}


def write_inductance(options):
    context, model, copper, output = [options[k] for k in ["context", "model", "copper", "output"]]
    from planar import nonempty_polygons
    settings = context["settings"]
    references = {ref["from"]["netId"] for ref in context["returns"]}
    foils = model["multilayer"]["stackup"]["copperLayers"]
    nodes, segments, equivalences = {}, [], []

    def node(xyz):
        key = tuple(round(float(q), 8) for q in xyz)
        if key not in nodes:
            nodes[key] = f"N{len(nodes)}"
        return nodes[key]

    def segment(a, b, width, height, normal=(0, 0, 1), filaments=1):
        if a == b:
            return
        segments.append((a, b, width, height, normal, filaments))

    def center_z(foil):
        return (foil["zMin"] + foil["zMax"]) / 2

    def endpoint(terminal):
        xyz = terminal["positionMm"]
        foil = min(foils, key=lambda f: abs(f["zMax"] - xyz[2]))
        return node([*xyz[:2], center_z(foil)])

    gmsh.initialize();gmsh.option.setNumber("General.Verbosity", 1);gmsh.option.setNumber("General.NumThreads", 1)
    gmsh.option.setNumber("Mesh.RandomSeed", 1)
    gmsh.model.add("saved-reference-copper")
    cad_points, surfaces, contacts = {}, {}, defaultdict(list)

    def point(xy, z):
        key = tuple(round(float(q), 8) for q in [*xy, z])
        if key not in cad_points:
            cad_points[key] = gmsh.model.geo.addPoint(*key, settings["referenceMeshMm"])
        return cad_points[key]

    for foil in foils:
        z = center_z(foil)
        for net in sorted(references):
            sheet = copper.get(foil["name"], {}).get(net, Polygon())
            sheet = sheet.simplify(settings["referenceBoundaryToleranceMm"], preserve_topology=True)
            for polygon in nonempty_polygons(sheet):
                rings = []
                for ring in [polygon.exterior, *polygon.interiors]:
                    pts = [point(xy, z) for xy in list(ring.coords)[:-1]]
                    lines = [gmsh.model.geo.addLine(a, b) for a, b in zip(pts, pts[1:] + pts[:1])]
                    rings.append(gmsh.model.geo.addCurveLoop(lines))
                tag = gmsh.model.geo.addPlaneSurface(rings)
                surfaces[tag] = (foil, net, polygon)
                required = [terminal["positionMm"][:2] for ref in context["returns"] if ref["from"]["netId"] == net for terminal in [ref["from"], ref["to"]] if abs(terminal["positionMm"][2] - center_z(foil)) < 1e-6]
                for barrel in model["multilayer"]["barrels"]:
                    if barrel["netId"] != net or not barrel["zMin"] <= z <= barrel["zMax"]:
                        continue
                    hole = Polygon([(p["x"], p["y"]) for p in barrel["hole"]])
                    xy = np.array(hole.centroid.coords[0]);radius = hole.bounds[2] - xy[0] + barrel["platingThickness"] / 2
                    required.extend(xy + radius * np.array([math.cos(a), math.sin(a)]) for a in np.linspace(0, 2 * math.pi, 4, endpoint=False))
                for xy in required:
                    if polygon.contains(Point(*xy)):
                        contacts[tag].append(point(xy, z))
    gmsh.model.geo.synchronize()
    for surface, tags in contacts.items():
        gmsh.model.mesh.embed(0, list(set(tags)), 2, surface)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
    gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
    gmsh.option.setNumber("Mesh.MeshSizeMax", settings["referenceMeshMm"])
    gmsh.model.mesh.generate(2)
    tags, coordinates, _ = gmsh.model.mesh.getNodes()
    positions = dict(zip(map(int, tags), np.asarray(coordinates).reshape(-1, 3)))
    edge_weights = defaultdict(float);edge_foils = {};triangle_count = 0
    for surface, (foil, _, _) in surfaces.items():
        kinds, _, triangles = gmsh.model.mesh.getElements(2, surface)
        if list(kinds) != [2]:
            raise ValueError("Reference foil mesh must contain triangles")
        for triangle in np.asarray(triangles[0]).reshape(-1, 3):
            xyz = [positions[int(t)] for t in triangle];triangle_count += 1
            for i in range(3):
                a, b, opposite = xyz[i], xyz[(i + 1) % 3], xyz[(i + 2) % 3]
                u, v = a - opposite, b - opposite
                cotangent = np.dot(u, v) / np.linalg.norm(np.cross(u, v))
                edge = tuple(sorted((int(triangle[i]), int(triangle[(i + 1) % 3]))))
                edge_weights[edge] += cotangent / 2;edge_foils[edge] = foil
    omitted = 0
    for (a, b), weight in edge_weights.items():
        if weight <= 1e-10:
            omitted += 1
            continue
        length = np.linalg.norm(positions[a] - positions[b]);foil = edge_foils[(a, b)]
        # Cotangent finite-volume sheet conductance determines bar cross-section.
        direction = positions[b] - positions[a];normal = (-direction[1], direction[0], 0)
        segment(node(positions[a]), node(positions[b]), weight * length, foil["zMax"] - foil["zMin"], normal)
    gmsh.write(str(output / "reference-foil-mesh.msh"));gmsh.finalize()
    # Copper barrel filaments connect the real foils, including unused spans.
    for barrel in model["multilayer"]["barrels"]:
        hole = Polygon([(p["x"], p["y"]) for p in barrel["hole"]]);xy = np.array(hole.centroid.coords[0])
        radius = hole.bounds[2] - xy[0] + barrel["platingThickness"] / 2
        levels = sorted({barrel["zMin"], barrel["zMax"], *(center_z(f) for f in foils if barrel["zMin"] <= center_z(f) <= barrel["zMax"])})
        net = barrel["netId"]; signal = next((s for s in context["signals"] if s["from"]["netId"] == net), None)
        for angle in np.linspace(0, 2 * math.pi, 4, endpoint=False):
            location = xy + radius * np.array([math.cos(angle), math.sin(angle)])
            for low, high in zip(levels, levels[1:]):
                segment(node([*location, low]), node([*location, high]), 2 * math.pi * radius / 4, barrel["platingThickness"], (math.cos(angle), math.sin(angle), 0))
            if signal:
                for z in levels:
                    if any(abs(z - center_z(f)) < 1e-8 for f in foils):
                        equivalences.append((node([*location, z]), node([*xy, z])))
    for signal in context["signals"]:
        route = signal["route"]
        for a, b in zip(route, route[1:]):
            if b["route_type"] == "via":
                continue
            layer = a.get("to_layer") if a["route_type"] == "via" else a["layer"]
            foil = next(f for f in foils if f["name"] == layer);z = center_z(foil)
            direction = np.array([b["x"] - a["x"], b["y"] - a["y"]])
            if np.linalg.norm(direction) < 1e-10:
                continue
            segment(node([a["x"], a["y"], z]), node([b["x"], b["y"], z]), b["width"], foil["zMax"] - foil["zMin"], (-direction[1], direction[0], 0), settings["signalFilaments"])
    ground_source, ground_receiver = [endpoint(context["returns"][0][key]) for key in ["from", "to"]]
    for reference in context["returns"][1:]:
        equivalences.extend([(endpoint(reference["from"]), ground_source), (endpoint(reference["to"]), ground_receiver)])
    for signal in context["signals"]:
        equivalences.append((endpoint(signal["to"]), ground_receiver))
    ports = [(endpoint(signal["from"]), ground_source) for signal in context["signals"]]
    parent = {}
    def find(name):
        parent.setdefault(name, name)
        if parent[name] != name:
            parent[name] = find(parent[name])
        return parent[name]
    for a, b in [(a,b) for a,b,*_ in segments] + equivalences:
        parent[find(a)] = find(b)
    if any(find(a) != find(b) for a,b in ports):
        raise ValueError("Extracted impedance port has no copper return path; check source reference contacts and crop")
    lines = ["* Actual PCB paths and meshed reference copper; ideal AC rail joins at terminals\n.units m\n", f".default sigma={context['conductivitySm']:.12g} nwinc=1 nhinc=1\n"]
    lines.extend(f"{name} x={xyz[0]/1000:.12g} y={xyz[1]/1000:.12g} z={xyz[2]/1000:.12g}\n" for xyz, name in nodes.items())
    node_positions = {name: np.array(xyz) for xyz, name in nodes.items()}
    for i, (a, b, width, height, normal, filaments) in enumerate(segments):
        direction = node_positions[b] - node_positions[a]
        if direction[2] == 0:
            normal = (-direction[1], direction[0], 0)
        lines.append(f"E{i} {a} {b} w={width/1000:.12g} h={height/1000:.12g} wx={normal[0]:.12g} wy={normal[1]:.12g} wz={normal[2]:.12g} nwinc={filaments}\n")
    lines.extend(f".equiv {a} {b}\n" for a, b in dict.fromkeys(equivalences))
    lines.extend(f".external {a} {b}\n" for a,b in ports)
    lines.append(f".freq fmin={settings['modelHz']:.12g} fmax={settings['modelHz']:.12g} ndec=1\n.end\n")
    (output / "channel.inp").write_text("".join(lines))
    return {"referenceTriangles": triangle_count, "referenceSegments": len(edge_weights) - omitted, "nonpositiveMeshEdgesOmitted": omitted, "nodes": len(nodes), "segments": len(segments), "portOrder": [s["name"] for s in context["signals"]], "portNodes": ports}


def prepare(input_file, output, mode="all"):
    context = json.loads(Path(input_file).read_text());sys.path.insert(0, context["pythonGeometryPath"])
    from planar import build_layer_copper, clean, copper_overlaps
    model = context["model"];settings = context["settings"]
    board, copper = build_layer_copper(model)
    paths = [p for signal in context["signals"] for p in signal["route"]]
    margin = settings["marginMm"]
    bounds = [min(p["x"] for p in paths)-margin, min(p["y"] for p in paths)-margin, max(p["x"] for p in paths)+margin, max(p["y"] for p in paths)+margin]
    for reference in context["returns"]:
        for terminal in [reference["from"], reference["to"]]:
            x, y = terminal["positionMm"][:2]
            bounds = [min(bounds[0], x-margin), min(bounds[1], y-margin), max(bounds[2], x+margin), max(bounds[3], y+margin)]
    board = clean(board.intersection(box(*bounds)))
    selected = set(context["selectedNetIds"])
    copper = {layer: {net: clean(shape.intersection(board)) for net, shape in groups.items() if net in selected} for layer, groups in copper.items()}
    overlaps = copper_overlaps(copper)
    if overlaps:
        (output / "copper-overlaps.json").write_text(json.dumps(overlaps, indent=2))
        raise ValueError("Selected physical copper contains different-net overlaps; see copper-overlaps.json")
    model = {**model, "multilayer": {**model["multilayer"], "barrels": [barrel for barrel in model["multilayer"]["barrels"] if barrel["netId"] in selected and board.covers(Polygon([(p["x"],p["y"]) for p in barrel["hole"]]))]}}
    options = {"model": model, "board": board, "copper": copper, "context": context, "output": output}
    inductance, capacitance = None, None
    if mode in ["all", "inductance"]:
        progress("Mesh actual reference foils and routed filament paths")
        tolerance = settings.get("impedanceSurfaceToleranceMm", settings["surfaceToleranceMm"])
        impedance_copper = {layer: {net: shape.simplify(tolerance, preserve_topology=True) for net, shape in groups.items()} for layer, groups in copper.items()}
        inductance = write_inductance({**options, "copper": impedance_copper})
    if mode in ["all", "capacitance"]:
        progress("Panel actual conductor and homogeneous-dielectric conductor surfaces")
        capacitance_copper = {layer: {net: shape.simplify(settings["surfaceToleranceMm"], preserve_topology=True) for net, shape in groups.items()} for layer, groups in copper.items()}
        capacitance = write_capacitance({**options, "copper": capacitance_copper})
    summary = {"boundsMm": bounds, "settings": settings, "selectedSignals": [s["name"] for s in context["signals"]], "referenceNets": [r["from"]["netId"] for r in context["returns"]], "sourceGeometryPackage": context["sourceGeometryPackage"], "copperAreaMm2": {layer: {net: shape.area for net,shape in groups.items()} for layer,groups in copper.items()}, "inductance": inductance, "capacitance": capacitance, "limitations": ["Whole-route quasistatic RLGC homogenization; no spatially resolved distributed coupling or full-wave radiation", "Reference foils use a cotangent sheet-to-filament mesh; nonpositive mesh edges omitted and counted", "Selected rails ideal AC-connected at source and receiver; no package or PDN impedance", "Copper barrels use four parallel filaments for impedance; conductor surface geometry remains polygonal", "Capacitance uses explicit homogeneous permittivity; dielectric interfaces and air-filled voids are not solved", "Crop truncates surrounding planes; dielectric loss is not included in the passive constant-RLC ladder"]}
    (output / "geometry-summary.json").write_text(json.dumps(summary, indent=2))
    progress(json.dumps({"inductance": inductance, "capacitance": capacitance}))


if __name__ == "__main__":
    prepare(sys.argv[1], Path(sys.argv[2]), sys.argv[3] if len(sys.argv)>3 else "all")
