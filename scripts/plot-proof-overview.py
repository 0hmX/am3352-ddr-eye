"""Compare the three actual receiver eyes on a common two-UI time axis."""
import csv
import json
import sys
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

root = Path(sys.argv[1])
proof = json.loads((root / "proof.json").read_text())
titles = {"ddr": "DDR · TI AM335x → Winbond", "differential-data": "RS-485 · TI SN65HVD72", "single-ended": "CMOS · TI SN74LVC1G04"}
figure, axes = plt.subplots(1, len(proof["cases"]), figsize=(15, 4.5))
for axis, case in zip(axes, proof["cases"]):
    run = root / case["name"] / "run-a"
    receipt = json.loads((run / "receipt.json").read_text())
    experiment = receipt["experiments"][0]
    eye = experiment["eyes"][0]
    windows = {}
    with (run / experiment["directory"] / eye["directory"] / "eye-data.csv").open() as stream:
        for row in csv.DictReader(stream):
            windows.setdefault(row["window"], []).append((float(row["folded_time_s"]) / eye["unitIntervalSeconds"], float(row["voltage_v"])))
    for rows in windows.values():
        axis.plot(*zip(*rows), color="#087e8b", alpha=0.28, linewidth=0.9)
    axis.axvline(1, color="#667085", linestyle="--", linewidth=0.8)
    axis.set(title=f'{titles[case["name"]]}\nUI {eye["unitIntervalSeconds"] * 1e9:g} ns · {len(windows)} windows', xlabel="Folded time / UI", ylabel="Probe voltage (V)", xlim=(0, 2))
    axis.grid(alpha=0.18)
figure.suptitle("Actual native solver eyes · explicit timing origins")
figure.tight_layout()
figure.savefig(root / "eye-overview.png", dpi=160)
figure.savefig(root / "eye-overview.svg", metadata={"Date": None})
