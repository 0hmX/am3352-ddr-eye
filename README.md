# tscircuit local signal-integrity simulation

Run native tscircuit TSX through local FastHenry, FasterCap, and ngspice, then inspect interactive waveforms, eye diagrams, and CSV results. The DDR example simulates DQ0 with quiet and switching DQS/DQSn neighbors.

**Python is not required. External solvers are downloaded and installed separately; they are not bundled with this repository.** Ordinary dependency installation, preview, and circuit builds do not install or run those solvers.

## Requirements

- Node.js **22.13 or newer**; validation used Node 24.
- pnpm **11.25.0**, matching `package.json`, and Git.
- macOS: Xcode command-line tools and [Homebrew](https://brew.sh/). If needed, run `xcode-select --install` and finish installation before continuing. The setup command below installs CMake, LLVM, and libomp through Homebrew.
- Debian/Ubuntu Linux: an account that can run `sudo apt-get`, or root. The setup command installs the compiler, Git, curl, CMake, bison, flex, and bzip2.

macOS Apple Silicon is the validated platform. Linux setup is implemented but has not been validated end to end. The native installer does not support Windows.

## Clone, install, and see the DDR results

Run these commands in a terminal after installing the requirements above:

```sh
git clone https://github.com/0hmX/am3352-ddr-eye.git
cd am3352-ddr-eye
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile

pnpm simulate:setup --install-deps
pnpm exec pcb-spice-pipeline --check-tools

pnpm simulate:ddr-dq --out .tscircuit/ddr --open
```

`simulate:setup` first downloads and verifies the vendor models into `models/`, then builds the pinned, unmodified solver sources into `node_modules/.cache/pcb-spice-pipeline/tools`. Setup needs network access and can take several minutes. If all build prerequisites are already installed, use `pnpm simulate:setup` without `--install-deps`.

The final command runs both `DDR_QUIET` and `DDR_SWITCHING` and opens `.tscircuit/ddr/results.html`. The simulation can also take several minutes. Each experiment uses one native ngspice transient for all its probes and eyes.

The project currently pins matching PR previews of [core](https://github.com/tscircuit/core/pull/4765), [props](https://github.com/tscircuit/props/pull/945), and [Circuit JSON](https://github.com/tscircuit/circuit-json/pull/908). Use the checked-in lockfile to install the API these examples require.

### Compare quiet and switching neighbors

Use the DDR run created above:

```sh
pnpm simulate:compare .tscircuit/ddr --probe DQ0_RX --out .tscircuit/comparison --open
```

This opens `.tscircuit/comparison/results.html` and writes `comparison.csv` alongside the other CSV exports. Comparison checks that the circuit, models, victim traffic, rails, and geometry match; only the selected neighbors' traffic may change. It currently requires a ground-referenced single-ended victim probe. Differences use the union of adaptive timestamps, with RMS integrated over time.

Output directories must be **new**. For another run, choose another `--out` path, or omit `--out` to create a timestamped directory under `dist/`. Reopen an existing report directly in your browser; reopening it does not rerun the solvers.

## Other examples and circuit preview

| Command | Simulation |
| --- | --- |
| `pnpm simulate --open` | AM3352 differential DQS/DQSn, two selected traces |
| `pnpm simulate:ddr-dq --open` | DQ0 victim with DQS/DQSn neighbors, three selected traces, quiet/switching experiments |
| `pnpm simulate:single-ended --open` | SN74LVC1G04 CMOS pad/channel |
| `pnpm simulate:non-ddr --open` | SN65HVD72 RS-485 pad/channel with termination |

For circuit preview and export, run:

```sh
pnpm typecheck
pnpm build
pnpm dev
```

`pnpm dev` starts the circuit preview. Run simulation commands in another terminal. Preview and build render native simulation declarations without downloading IBIS assets or executing `pcb_spice` experiments.

## Results

`results.html` works offline and has Board, Tests, Results, Plots, CSV files, and Model tabs. Unused routing and component bounds appear in gray; simulated components and selected traces are highlighted. All board layers are projected into a top view.

Select an experiment or probe, overlay waveforms, switch to an eye diagram, scroll to zoom, drag to pan, or enter an exact time range. The cursor reports an actual adaptive solver sample. Plot display envelopes preserve extrema; numerical analysis uses the complete recorded samples.

Every run writes a `csv/` directory with:

- `trace-map.csv`, `probe-map.csv`, and `test-plan.csv` identifying the circuit and tests.
- `results-summary.csv` and `eye-summary.csv` summarizing observations.
- Numbered waveform and eye CSVs for each experiment.

Comparison adds `comparison.csv`. Units are seconds and volts unless a column says otherwise. Keep the HTML and its CSV directory together for file downloads; plots and the in-page waveform export also work with the HTML alone.

The full run directory also contains captured inputs and model bytes, geometry and R/L/C matrices, generated SPICE decks, native commands and logs, probe-bound `circuit-results.json`, and a hash-bound `receipt.json`. Generated results and prepared models are ignored by Git.

## Native TSX API

Simulation declarations use the native API from `@tscircuit/core` and model types from `@tscircuit/props`. Inside a board with routed TX/RX components:

```tsx
import { analog } from "@tscircuit/core"
import { inputPad, outputPad } from "./examples/single-ended/models"

export function CmosSimulation() {
  return <>
<ibismodel componentRef="chip.TX" {...outputPad} />
<ibismodel componentRef="chip.RX" {...inputPad} />
<analog.transientsimulation
  name="SI" spiceEngine="pcb_spice" duration="1600ns" timePerStep="50ps"
  ibisPinStates={{
    ".TX > .Y": { isOutput: true, isOutputEnabled: true },
    ".RX > .A": { isOutput: false },
  }}
/>
<analog.digitalstimulus name="DATA" simulationRef=".SI" drives=".TX > .Y"
  unitInterval="50ns" startTime="0ns" initialState={0}
  pattern={{ type: "bits", bits: "001110100101011000101101", repeat: true }} />
<voltageprobe name="DATA_RX" connectsTo=".RX > .A" referenceTo=".RX > .GND" />
<analog.eyediagram name="CMOS_DATA" simulationRef=".SI" probeRef=".DATA_RX"
  unitInterval="50ns" timeOrigin="0ns" startTime="200ns" />
  </>
}
```

See the complete [CMOS circuit](examples/single-ended/index.circuit.tsx), [model definitions](examples/single-ended/models.ts), and [physical modeling configuration](examples/single-ended/simulation.config.ts). The entry must export `modeling` with selected routes, stackup, conductor/return geometry, materials, and extraction settings. The runner consumes the canonical Circuit JSON records and executes only experiments with `spiceEngine="pcb_spice"`.

An IBIS model uses a shared Asset reference:

```ts
const ibisModelAsset = {
  project_relative_path: "models/sn74lvc1g04.ibs",
  url: "./models/sn74lvc1g04.ibs",
  mimetype: "text/plain",
}
```

`project_relative_path` is relative to the circuit project's root, including when the entry is in an example subdirectory. The runner reads that file first; if absent, it can fetch an HTTP(S) `url`. Assets must be extracted `.ibs` files, not ZIP archives. `pnpm simulate:models` prepares the repository's models without installing solvers. Their expected byte hashes are declared separately in `modeling.ibisModelAssetSha256` and checked before simulation.

Physical IBIS pin names map to TSX port labels through `ibisPinNameToPortLabel`; selected buffers, reference rails, `modelValueCorner`, and `includePackageParasitics` are explicit. Use component selectors such as `chip.U1` when BGA pin names could also match `.U1`.

For a saved board, import `ImportedBoard` from `pcb-spice-pipeline/tsx` and put native simulation declarations **inside** it:

```tsx
<ImportedBoard circuitJson={savedBoard}>
  <ibismodel componentRef="chip.U1" {...driver} />
  {/* Native transient, stimulus, probe, and eye declarations go here. */}
</ImportedBoard>
```

The bridge preserves the original physical records and verifies the mapping of referenced native pins and nets. Saved footprints are represented as generic chips for preview. Additional physical children, ambiguous bindings, and previously saved simulation declarations/results are rejected. To run an existing Circuit JSON simulation, export `circuitJson` and `modeling` directly instead. See the [DDR example](examples/ddr-dq/index.circuit.tsx).

## Troubleshooting and verification

| Problem | Action |
| --- | --- |
| pnpm will not start | Check `node --version` is at least 22.13 and `pnpm --version` is 11.25.0. |
| Native solvers are not installed | Finish `pnpm simulate:setup`, then run `pnpm exec pcb-spice-pipeline --check-tools`. |
| IBIS asset is missing or its bytes differ | Run `pnpm simulate:models`. Vendor downloads must match their locks; do not edit prepared files. |
| Output directory already exists | Choose a new `--out` path or omit `--out`. |
| Setup or a native solver fails | Read the stdout/stderr log paths in the error. Setup logs are under the tools directory's `logs/`; run logs are in the output directory. |
| No browser opens | Open the printed `results.html` path manually. Linux `--open` uses `xdg-open`. |

Native tools normally live under `node_modules/.cache/pcb-spice-pipeline/tools`. `PCB_SPICE_CACHE` changes the runtime cache location. For an explicit tools installation:

```sh
pnpm simulate:setup --tools-dir /absolute/path/to/tools
PCB_SPICE_TOOLS=/absolute/path/to/tools/tools.json pnpm simulate:ddr-dq --open
```

Setup records source revisions, checksums, build commands, executable hashes, and installed runtime libraries. Solvers must pass these checks before execution. Local/user ngspice startup files are ignored, and runtime-library overrides are rejected. See the [toolchain lock](packages/pcb-spice-pipeline/toolchain-lock.json) for pinned sources and license details. Vendor files are fetched locally and are not redistributed in the repository.

```sh
pnpm typecheck
pnpm build
pnpm test:native
pnpm simulate:prove
```

`test:native` requires installed solvers and prepared models. It tests the full three-signal complex network, real vendor fixtures, received data histories, startup, probe associations, and eye gates. `simulate:prove` runs all four examples twice with fresh solves and independent artifact audits, so it takes longer. Unit tests run with `pnpm test` and additionally require Bun; normal simulation does not.

## Model scope

The backend supports **one to three selected coupled channels** and unswept transient experiments. It preserves mutual R/L/C coupling and an explicit finite return conductor. Unused traces remain visible in the report but are not included in the electrical solve.

Routed lengths and widths are straightened into stages with assumed spacing, homogeneous effective dielectric, and fixed-frequency R/L. Full planes, unselected nearby nets, dielectric loss, copper roughness, complete via pads/stubs, and the board PDN are omitted. Reference rails use explicit ideal supplies. The DDR comparison assumes uniform 0.75 mm center spacing and continuous write-direction pad/channel activity; controller logic, commands, bursts, training, and clock recovery are not modeled. The source board is an incomplete saved routing checkpoint.

These are finite observed transient eyes, without BER extrapolation, protocol compliance, or a hardware accuracy claim. IBIS currents outside characterized voltage ranges hold the endpoint current, with the approximation recorded in metadata. The unterminated CMOS fixture rings above its 3.3 V rail and its selected input lacks a power-clamp table; the raw excursions remain visible and do not establish a safe interface. Package parasitics are omitted where the backend cannot represent the vendor data, with omissions recorded in the receipt.
