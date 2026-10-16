"""Verify received bits at real DQS crossings; plot only fresh recorded solver data."""
from pathlib import Path
import hashlib
import json
import sys
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.lines import Line2D
import numpy as np

root = Path(sys.argv[1]).resolve()
out = root / "plots"
out.mkdir(exist_ok=True)
read = lambda path: json.loads(path.read_text())
digest = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
expected_contexts = [f"{i:03b}" for i in range(8)]
colors = dict(zip(expected_contexts, plt.get_cmap("tab10").colors[:8]))
plt.rcParams.update({"font.size": 10, "axes.spines.top": False,
                     "axes.spines.right": False, "svg.hashsalt": "ddr-dq-eight-contexts"})
reports = []
for run_name in ["run-a", "run-b"]:
    run = root / run_name
    receipt = read(run / "receipt.json")
    assert receipt["execution"]["solverResultCache"] is False
    experiment, = receipt["experiments"]
    folder = run / experiment["directory"]
    plan = read(folder / "experiment.json")
    stimulus, = [s for s in plan["stimuli"] if s["name"] == "DQ0"]
    bits = stimulus["pattern"]["bits"]
    assert bits == "00010111" and stimulus["pattern"]["repeat"]
    assert not stimulus["inverted"] and stimulus["initial_state"] == 0
    ui, epoch = stimulus["unit_interval_ms"] / 1000, stimulus["start_time_ms"] / 1000
    probes = {p["name"]: p["column"] for p in plan["probes"]}
    wave = np.loadtxt(folder / "waveform.csv", delimiter=",", skiprows=1)
    assert digest(folder / "waveform.csv") == receipt["files"][experiment["directory"] + "/waveform.csv"]
    time = wave[:, 0]
    dq, strobe = wave[:, probes["DQ0_RX"]], wave[:, probes["DDR_RX"]]
    eye, = [e for e in experiment["eyes"] if e["name"] == "DQ0_receive_eye"]
    gate_start, gate_end = eye["startTimeSeconds"], eye["endTimeSeconds"]
    circuit = read(run / "inputs/circuit.json")
    supply, = [s["voltage"] for s in circuit if s["type"] == "simulation_voltage_source"]
    threshold = supply / 2
    # Both positive and negative differential strobe crossings sample DDR data.
    crossing_indices = np.flatnonzero((strobe[:-1] < 0) != (strobe[1:] < 0))
    sampled = []
    for i in crossing_indices:
        crossing = time[i] - strobe[i] * (time[i+1] - time[i]) / (strobe[i+1] - strobe[i])
        if not gate_start <= crossing < gate_end:
            continue
        index = int(np.floor((crossing - epoch) / ui))
        value = float(np.interp(crossing, time, dq))
        decoded, expected = int(value > threshold), int(bits[index % len(bits)])
        assert decoded == expected, (run_name, index, value, expected)
        assert abs(value - threshold) > .05, "Ambiguous DQ sample at the declared analysis threshold"
        if sampled:
            assert index == sampled[-1]["bitIndex"] + 1, "One DQS crossing per consecutive DQ bit"
        sampled.append({"bitIndex": index, "timeSeconds": float(crossing),
                        "voltageV": value, "bit": decoded})
    contexts = {}
    for i in range(len(sampled)-2):
        context = "".join(str(s["bit"]) for s in sampled[i:i+3])
        contexts.setdefault(context, []).append(sampled[i]["bitIndex"])
    assert sorted(contexts) == expected_contexts, "All eight histories must occur in the received bits"
    samples_by_bit = {s["bitIndex"]: s for s in sampled}
    eye_folder = folder / eye["directory"]
    meta = read(eye_folder / "eye-data.json")
    assert meta["sourceSha256"] == digest(folder / "waveform.csv")
    folded = np.loadtxt(eye_folder / "eye-data.csv", delimiter=",", skiprows=1)
    eye_contexts = {}
    for window, boundary in enumerate(meta["boundaryIndices"]):
        context = "".join(str(samples_by_bit[i]["bit"]) for i in [boundary-1, boundary, boundary+1])
        eye_contexts[window] = context
    assert sorted(set(eye_contexts.values())) == expected_contexts
    native_command = read(folder / "ngspice.command.json")
    reports.append({"run": run_name, "waveformSha256": digest(folder / "waveform.csv"),
                    "ngspice": {k: native_command[k] for k in ["exitCode", "elapsedMs", "timeoutMs"]},
                    "analysisThresholdV": threshold, "samples": sampled,
                    "receivedThreeBitHistoryCounts": {k: len(contexts[k]) for k in expected_contexts},
                    "eyeWindowHistoryCounts": {k: list(eye_contexts.values()).count(k) for k in expected_contexts},
                    "eyeWindows": meta["windows"], "waveformSamples": len(wave)})
    if run_name != "run-a":
        continue
    def save(fig, name):
        fig.savefig(out / (name + ".png"), dpi=170)
        fig.savefig(out / (name + ".svg"), metadata={"Date": None})
        plt.close(fig)
    # Two cycles of actual pad voltages, including the independently driven timing strobe.
    lower, upper = gate_start, gate_start + 16 * ui
    mask = (time >= lower) & (time <= upper)
    fig, axes = plt.subplots(2, 1, figsize=(12, 6), sharex=True, layout="constrained")
    for name, color in [("DQ0_TX", "#cb671b"), ("DQ0_RX", "#087f8c")]:
        axes[0].plot(time[mask]*1e9, wave[mask, probes[name]], label=name, color=color)
    axes[0].axhline(threshold, color="#666", ls=":", label=f"{threshold:g} V analysis threshold")
    for s in sampled:
        if lower <= s["timeSeconds"] <= upper:
            axes[0].plot(s["timeSeconds"]*1e9, s["voltageV"], "o", ms=4, color="#222")
    for i in range(int(round((lower-epoch)/ui)), int(round((upper-epoch)/ui))):
        axes[0].text((epoch+(i+.5)*ui)*1e9, 1.02, bits[i % len(bits)],
                     transform=axes[0].get_xaxis_transform(), ha="center", fontsize=11)
    for name, label, color in [("DDR_TX", "DQS TX: P − N", "#9c6ade"),
                                ("DDR_RX", "DQS RX: P − N", "#293a8a")]:
        axes[1].plot(time[mask]*1e9, wave[mask, probes[name]], label=label, color=color)
    axes[1].axhline(0, color="#666", ls=":")
    for ax in axes:
        ax.set_ylabel("Voltage (V)")
        ax.grid(alpha=.18)
        ax.legend(loc="upper left", bbox_to_anchor=(1.01, 1), fontsize=9)
    axes[1].set(xlabel="Actual ngspice time (ns)", xlim=(lower*1e9, upper*1e9))
    fig.suptitle("DDR DQ0 data and DQS strobe · actual TI/Winbond pad voltages\n"
                 "Dots: DQ0 RX sampled at both polarities of the received DQS crossing")
    save(fig, "waveforms")
    fig, ax = plt.subplots(figsize=(10, 6), layout="constrained")
    for window, context in eye_contexts.items():
        segment = folded[folded[:, 0] == window]
        ax.plot(segment[:, 1]*1e9, segment[:, 3], color=colors[context], alpha=.5, lw=1)
    ax.axhline(threshold, color="#666", ls=":", lw=.8)
    ax.axvline(ui*1e9, color="#666", ls=":", lw=.8)
    ax.set(xlabel="Folded time (ns)", ylabel="DQ0 RX relative to VSS (V)", xlim=(0, 2*ui*1e9))
    ax.grid(alpha=.18)
    ax.legend(handles=[Line2D([0], [0], color=colors[c], label=c) for c in expected_contexts],
              title="Previous / current / next received bits", ncol=8,
              loc="upper center", bbox_to_anchor=(.5, -.14))
    ax.set_title(f"DDR DQ0 receiver eye · all 8 received three-bit histories\n"
                 f"{meta['windows']} windows · UI {ui*1e9:g} ns · fixed source timing origin")
    save(fig, "dq0-eye-all-eight")
    fig, axes = plt.subplots(2, 4, figsize=(13, 6), sharex=True, sharey=True, layout="constrained")
    for context, ax in zip(expected_contexts, axes.flat):
        index = next(i for i in contexts[context] if epoch+(i+3)*ui <= gate_end)
        start = epoch + index*ui
        take = (time >= start) & (time <= start+3*ui)
        ax.plot((time[take]-start)*1e9, dq[take], color=colors[context], lw=1.4)
        for j, bit in enumerate(context):
            s = samples_by_bit[index+j]
            ax.plot((s["timeSeconds"]-start)*1e9, s["voltageV"], "o", color="#222", ms=4)
            ax.text((j+.5)*ui*1e9, .68, bit, transform=ax.get_xaxis_transform(), ha="center")
            if j:
                ax.axvline(j*ui*1e9, color="#aaa", ls=":", lw=.6)
        ax.axhline(threshold, color="#888", ls=":", lw=.6)
        ax.set_title(f"{context} · bit {index}")
        ax.grid(alpha=.15)
        ax.set_xlim(0, 3*ui*1e9)
    fig.supxlabel("Time within three consecutive DQ bits (ns)")
    fig.supylabel("Actual DQ0 RX voltage (V)")
    fig.suptitle("Each of the 8 histories observed in the same receiver waveform\n"
                 "Dots mark samples at the actual received DQS crossings")
    save(fig, "eight-received-histories")
assert reports[0]["waveformSha256"] == reports[1]["waveformSha256"], "Fresh waveforms differ"
plot_hashes = {p.name: digest(p) for p in sorted(out.iterdir()) if p.suffix in [".png", ".svg"]}
limits = "Fixed source timing origin, reduced channel, omitted package, ideal supplies; no clock recovery, DDR protocol/core or compliance test"
(root / "dq-coverage.json").write_text(json.dumps({
    "status": "passed", "runs": reports,
    "plotterSha256": digest(Path(__file__)),
    "plotSha256": plot_hashes,
    "decoding": "Sample DQ0 receiver voltage at actual differential DQS zero crossings; threshold = ideal VDDQ/2",
    "eye": "Unmodified pipeline two-UI samples; colors identify verified previous/current/next received bits",
    "limits": limits,
}, indent=2) + "\n")
reference = read(root / "run-a/receipt.json")
models = read(root / "run-a" / reference["experiments"][0]["assembly"])
repeated = read(root / "repeatability.json")
(root / "proof-summary.json").write_text(json.dumps({
    "status": "passed", "command": "pnpm simulate:ddr-dq",
    "entry": reference["project"]["entry"],
    "executedAtUtc": reference["execution"]["timestampUtc"],
    "solverResultsReused": False,
    "runs": [{**{k: v for k, v in report.items() if k != "samples"},
              "receivedBitsCheckedAtDqsCrossings": len(report["samples"])} for report in reports],
    "byteIdenticalFiles": repeated["comparison"]["compared"],
    "vendorSources": reference["vendorSources"],
    "vendorPins": [{"component": model["definition"]["component"],
                    "pins": [{k: pin[k] for k in ["physicalPin", "model", "selector", "modelType", "runState"]}
                             for pin in model["metadata"]["pins"]]} for model in models],
    "projectSourceSha256": {name: info["sha256"] for name, info in reference["project"]["files"].items()},
    "toolSha256": {name: reference["toolEvidence"][name]["sha256"] for name in ["fasthenry", "fastercap", "ngspice"]},
    "plotterSha256": digest(Path(__file__)), "plotSha256": plot_hashes,
    "limits": limits,
}, indent=2) + "\n")
print("Received all 8 three-bit histories in both fresh runs; plots:", out)
