"""Shared comparison renderer: only recorded, probe-bound native results."""
import json
import sys
from pathlib import Path
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


def plot_comparison(manifest_path):
    manifest = json.loads(manifest_path.read_text())
    root = manifest_path.parent
    series = manifest["series"]
    plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False, "svg.hashsalt": "tscircuit-native-comparison-v1"})
    colors = ["#767d87", "#147a91", "#cc6326", "#6a42a4"]
    fig, axes = plt.subplots(2, 1, figsize=(12, 7), layout="constrained")
    waves = []
    for i, run in enumerate(series):
        wave = np.loadtxt(run["waveformPath"], delimiter=",", skiprows=1)
        waves.append(wave)
        start = run["eye"]["startTimeSeconds"]
        stop = min(run["eye"]["endTimeSeconds"], start + 8 * run["eye"]["unitIntervalSeconds"])
        gate = (wave[:, 0] >= start) & (wave[:, 0] <= stop)
        color = colors[i % len(colors)]
        axes[0].plot(wave[gate, 0] * 1e9, wave[gate, run["probe"]["column"]], label=run["label"], color=color, linewidth=1.2)
        samples = run.get("sampling", {}).get("samples", [])
        for failed, marker in [(False, "o"), (True, "x")]:
            selected = [sample for sample in samples if (sample["decoded"] != sample["expected"]) == failed and start <= sample["timeSeconds"] <= stop]
            if selected:
                axes[0].scatter([s["timeSeconds"] * 1e9 for s in selected], [s["voltageV"] for s in selected], color=color, marker=marker, s=20, zorder=4)
    axes[0].set(xlabel="Actual solver time (ns)", ylabel=f"{manifest['probeName']} (V)")
    if manifest.get("samplingProbeName"):
        axes[0].axhline(manifest["thresholdV"], color="#555", linestyle=":", linewidth=.8, label="Explicit sampling threshold")
    axes[0].legend();axes[0].grid(alpha=.2)
    # The two experiments within a routed run share one physical extraction.
    pairs = [(i - 1, i) for i in range(1, len(series)) if series[i]["root"] == series[i - 1]["root"]]
    for quiet, active in pairs:
        a, b = waves[quiet], waves[active]
        times = b[:, 0]
        baseline = np.interp(times, a[:, 0], a[:, series[quiet]["probe"]["column"]])
        gate = (times >= series[active]["eye"]["startTimeSeconds"]) & (times <= series[active]["eye"]["endTimeSeconds"])
        axes[1].plot(times[gate] * 1e9, (b[gate, series[active]["probe"]["column"]] - baseline[gate]) * 1000, color=colors[active % len(colors)], label=f"{series[active]['label']} minus {series[quiet]['label']}")
    axes[1].set(xlabel="Actual solver time (ns)", ylabel="Change in receive voltage (mV)")
    axes[1].grid(alpha=.2)
    if pairs:
        axes[1].legend()
    fig.suptitle("Native simulation comparison • fixed victim stimulus and probe")
    fig.savefig(root / "waveform-comparison.png", dpi=160)
    fig.savefig(root / "waveform-comparison.svg", metadata={"Date": None})
    plt.close(fig)
    fig, axes = plt.subplots(1, len(series), figsize=(5 * len(series), 5), sharex=True, sharey=True, layout="constrained", squeeze=False)
    for i, run in enumerate(series):
        ax = axes[0, i]
        eye = np.loadtxt(run["eyeCsv"], delimiter=",", skiprows=1)
        for window in np.unique(eye[:, 0]):
            rows = eye[eye[:, 0] == window]
            ax.plot(rows[:, 1] * 1e9, rows[:, 3], color=colors[i % len(colors)], alpha=.25, linewidth=.8)
        ax.set_title(run["label"])
        ax.set(xlabel="Folded time (ns)", xlim=(0, 2 * run["eye"]["unitIntervalSeconds"] * 1e9))
        ax.grid(alpha=.2)
    axes[0, 0].set_ylabel(f"{manifest['probeName']} (V)")
    fig.suptitle("Same eye timing and voltage scale • finite observed windows")
    fig.savefig(root / "eye-comparison.png", dpi=160)
    fig.savefig(root / "eye-comparison.svg", metadata={"Date": None})
    plt.close(fig)
    if not manifest.get("samplingProbeName"):
        return
    fig, axes = plt.subplots(1, len(series), figsize=(5 * len(series), 5), sharex=True, sharey=True, layout="constrained", squeeze=False)
    for i, run in enumerate(series):
        ax, wave = axes[0, i], waves[i]
        ui = run["eye"]["unitIntervalSeconds"]
        offsets = np.linspace(-ui, ui, 1200)
        windows = 0
        for sample in run["sampling"]["samples"]:
            times = sample["timeSeconds"] + offsets
            if times[0] < run["eye"]["startTimeSeconds"] or times[-1] > run["eye"]["endTimeSeconds"]:
                continue
            ax.plot(offsets * 1e9, np.interp(times, wave[:, 0], wave[:, run["probe"]["column"]]), color=colors[i % len(colors)], alpha=.25, linewidth=.8)
            windows += 1
        ax.axvline(0, color="#555", linestyle=":", linewidth=.8)
        ax.axhline(manifest["thresholdV"], color="#555", linestyle=":", linewidth=.8)
        ax.set(title=f"{run['label']}\n{windows} complete windows", xlabel="Time from measured receive DQS crossing (ns)", xlim=(-ui * 1e9, ui * 1e9))
        ax.grid(alpha=.2)
    axes[0, 0].set_ylabel(f"{manifest['probeName']} (V)")
    fig.suptitle("Receiver-strobe-aligned eye • both DQS edges • no setup/hold qualification")
    fig.savefig(root / "strobe-eye-comparison.png", dpi=160)
    fig.savefig(root / "strobe-eye-comparison.svg", metadata={"Date": None})
    plt.close(fig)


if __name__ == "__main__":
    plot_comparison(Path(sys.argv[1]))
