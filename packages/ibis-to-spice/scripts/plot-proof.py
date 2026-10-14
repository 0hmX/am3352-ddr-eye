"""Optional presentation plot: python -m pip install matplotlib==3.11.2."""
import csv
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parent.parent
with (root / "proof-results/native-dqs.csv").open() as file:
    rows = list(csv.DictReader(file))
time = [float(row["time_s"]) * 1e9 for row in rows]
voltage = [float(row["differential_voltage_V"]) for row in rows]
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "svg.hashsalt": "ibis-proof"})
fig, axis = plt.subplots(figsize=(10, 4), layout="constrained")
axis.plot(time, voltage, color="#176b50", linewidth=1.6)
axis.set(xlabel="Time (ns)", ylabel="V(DQS) − V(DQSn) (V)", xlim=(0, 40), ylim=(-1.2, 1.2))
axis.set_title("Native tscircuit TSX: TI AM335x → Winbond DDR3 receiver\n200 MHz differential DQS · 1.5 V rails · ideal traces", loc="left", fontsize=12)
axis.grid(alpha=.2)
axis.spines[["top", "right"]].set_visible(False)
fig.savefig(root / "proof-results/native-dqs-plot.png", dpi=160)
fig.savefig(root / "proof-results/native-dqs-plot.svg", metadata={"Date": None})
