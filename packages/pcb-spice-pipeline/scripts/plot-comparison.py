"""Shared plots from receipt-verified native waveforms and folded eye samples."""
import json
import sys
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

manifest_path = Path(sys.argv[1])
manifest = json.loads(manifest_path.read_text())
root, series = manifest_path.parent, manifest["series"]
plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False,
                     "svg.hashsalt": "tscircuit-native-comparison-v1"})
colors = plt.get_cmap("tab10").colors
waves = [np.loadtxt(run["waveformPath"], delimiter=",", skiprows=1, ndmin=2) for run in series]
fig, axes = plt.subplots(2, 1, figsize=(12, 7), layout="constrained")
for i, (run, wave) in enumerate(zip(series, waves)):
    start = run["eye"]["startTimeSeconds"]
    stop = min(run["eye"]["endTimeSeconds"], start + 8 * run["eye"]["unitIntervalSeconds"])
    gate = (wave[:, 0] >= start) & (wave[:, 0] <= stop)
    axes[0].plot(wave[gate, 0] * 1e9, wave[gate, run["probe"]["column"]],
                 label=run["label"], color=colors[i % len(colors)], linewidth=1)
axes[0].set(xlabel="Actual solver time (ns)", ylabel=f"{manifest['probeName']} (V)")
for pair in manifest["changes"]:
    quiet, active = pair["quietIndex"], pair["activeIndex"]
    a, b = waves[quiet], waves[active]
    times = np.unique(np.concatenate(([pair["startSeconds"], pair["endSeconds"]], a[:, 0], b[:, 0])))
    times = times[(times >= pair["startSeconds"]) & (times <= pair["endSeconds"])]
    baseline = np.interp(times, a[:, 0], a[:, series[quiet]["probe"]["column"]])
    switching = np.interp(times, b[:, 0], b[:, series[active]["probe"]["column"]])
    axes[1].plot(times * 1e9, (switching - baseline) * 1000, color=colors[active % len(colors)],
                 label=f"{series[active]['label']} minus {series[quiet]['label']}")
axes[1].set(xlabel="Union of recorded timestamps (ns), linear interpolation", ylabel="Receive voltage change (mV)")
for ax in axes:
    ax.legend()
    ax.grid(alpha=.2)
fig.suptitle("Native simulation comparison · fixed victim stimulus and extracted network")
for extension in ["png", "svg"]:
    fig.savefig(root / f"waveform-comparison.{extension}", dpi=160)
plt.close(fig)

fig, axes = plt.subplots(1, len(series), figsize=(5 * len(series), 5), sharex=True, sharey=True,
                         layout="constrained", squeeze=False)
for i, run in enumerate(series):
    ax = axes[0, i]
    eye = np.loadtxt(run["eyeCsv"], delimiter=",", skiprows=1, ndmin=2)
    for window in np.unique(eye[:, 0]):
        rows = eye[eye[:, 0] == window]
        ax.plot(rows[:, 1] * 1e9, rows[:, 3], color=colors[i % len(colors)], alpha=.25, linewidth=.8)
    ax.set(title=run["label"], xlabel="Folded time (ns)", xlim=(0, 2 * run["eye"]["unitIntervalSeconds"] * 1e9))
    ax.grid(alpha=.2)
axes[0, 0].set_ylabel(f"{manifest['probeName']} (V)")
fig.suptitle("Same eye timing and voltage scale · finite observed windows")
for extension in ["png", "svg"]:
    fig.savefig(root / f"eye-comparison.{extension}", dpi=160)
plt.close(fig)
(root / "plot-receipt.json").write_text(json.dumps({
    "matplotlib": matplotlib.__version__, "numpy": np.__version__, "python": sys.version,
    "input": "comparison.json", "scope": "Finite deterministic native simulation; no hardware or compliance claim"
}, indent=2) + "\n")
