# Run a circuit simulation

Choose a TSX file below, copy its command, and wait for the simulation to finish. The command then opens that example's **results in your web browser**: the board, waveforms, eye diagrams, and CSV downloads.

**`--open` means “open the results page in my browser when the simulation finishes.”** It does not open the TSX source file. Leave it off if you only want to save the results.

## 1. Set up once

You need Node.js **22.13 or newer**, Git, and pnpm **11.25.0**. On macOS, install Xcode command-line tools and [Homebrew](https://brew.sh/) first. On Debian/Ubuntu, setup needs access to `sudo apt-get` or root.

```sh
git clone https://github.com/0hmX/am3352-ddr-eye.git
cd am3352-ddr-eye
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm simulate:setup --install-deps
```

The last command downloads the vendor IBIS models and builds FastHenry, FasterCap, and ngspice on your computer. `--install-deps` also installs their compiler/build dependencies. If those dependencies are already installed, use `pnpm simulate:setup` instead.

Setup and simulations can take several minutes. Python is not required. External solvers are installed separately and are not bundled with the project. macOS Apple Silicon is validated; Linux setup is implemented but has not been validated end to end. The native installer does not support Windows.

## 2. Run the example you want

Run these commands from the `am3352-ddr-eye` folder. Each command creates a new results folder automatically.

### Default circuit: `index.circuit.tsx`

```sh
pnpm simulate --open
```

Runs [index.circuit.tsx](index.circuit.tsx). Opens the AM3352 DDR strobe report: **DQS/DQSn, two selected traces**, with transmit and receive waveforms and eyes.

### DDR data and strobe: `examples/ddr-dq/index.circuit.tsx`

```sh
pnpm simulate:ddr-dq --open
```

Runs [examples/ddr-dq/index.circuit.tsx](examples/ddr-dq/index.circuit.tsx). Opens the **DQ0 + DQS + DQSn, three-trace report**. It contains both `DDR_QUIET` and `DDR_SWITCHING` experiments so you can inspect the effect of neighbor switching.

### One CMOS signal: `examples/single-ended/index.circuit.tsx`

```sh
pnpm simulate:single-ended --open
```

Runs [examples/single-ended/index.circuit.tsx](examples/single-ended/index.circuit.tsx). Opens the **SN74LVC1G04 CMOS pad/channel report**, with transmitter and receiver waveforms and eyes.

### RS-485 pair: `examples/differential-data/index.circuit.tsx`

```sh
pnpm simulate:non-ddr --open
```

Runs [examples/differential-data/index.circuit.tsx](examples/differential-data/index.circuit.tsx). Opens the **SN65HVD72 RS-485 report**, with the A/B pair, receiver termination, differential results, and A-to-ground results.

## 3. Find or reopen your results

The terminal prints the exact results path. Each run saves a new folder such as:

```text
dist/simulation-<timestamp>/
  results.html
  csv/
  receipt.json
  ...solver inputs and logs
```

Open `results.html` in your browser to view that saved run again. This does not rerun the simulation. Keep the `csv/` directory beside it for CSV downloads.

The report has Board, Tests, Results, Plots, CSV files, and Model tabs. Unused traces and components are gray; simulated ones are highlighted. Select an experiment or probe, overlay waveforms, switch to eyes, zoom, or pan.

CSV exports include trace/probe maps, the test plan, result summaries, and waveform/eye samples. Units are seconds and volts unless a column says otherwise. The run also retains the generated SPICE decks, geometry, R/L/C matrices, model bytes, native command logs, and a hash-bound receipt. Generated files are ignored by Git.

## View the circuit design

```sh
pnpm dev
```

Starts the tscircuit design preview, with `index.circuit.tsx` as the default circuit. This shows the circuit design; use one of the four simulation commands above to generate simulation results. Keep the preview running in its terminal and run simulation commands in another terminal.

## If something fails

| What happened | What to do |
| --- | --- |
| A command is not found | Run it from the repository folder after `pnpm install --frozen-lockfile`. Check Node is at least 22.13 and pnpm is 11.25.0. |
| Solvers are not installed | Finish `pnpm simulate:setup`. Check them with `pnpm exec pcb-spice-pipeline --check-tools`. |
| An IBIS file is missing or changed | Run `pnpm simulate:models` to restore the vendor models. |
| No browser opens | Open the printed `results.html` path yourself. Linux automatic opening uses `xdg-open`. |
| A solver or setup fails | Read the stdout/stderr log paths printed in the error. |

<details>
<summary>Optional: compare DQ0 with quiet versus switching neighbors</summary>

First run the three-trace DDR example into a named folder, then create a comparison for its DQ0 receiver:

```sh
pnpm simulate:ddr-dq --out .tscircuit/ddr
pnpm simulate:compare .tscircuit/ddr --probe DQ0_RX --open
```

`--out` chooses where the first run is saved. That folder must not exist yet; use a different name for another run. `--probe DQ0_RX` chooses the DQ0 receiver signal to compare. The second command opens a comparison report and writes `comparison.csv`.

Comparison checks that models, victim traffic, rails, geometry, and other electrical conditions match. Only the selected neighbors' traffic may change. It currently requires a ground-referenced single-ended victim. Differences use the union of adaptive timestamps, with RMS integrated over time.

</details>

<details>
<summary>Writing your own TSX circuit</summary>

Start with the complete [CMOS circuit](examples/single-ended/index.circuit.tsx), its [IBIS model definitions](examples/single-ended/models.ts), and its [physical modeling configuration](examples/single-ended/simulation.config.ts).

The examples use native `<ibismodel>`, `<analog.transientsimulation>`, `<analog.digitalstimulus>`, `<voltageprobe>`, and `<analog.eyediagram>` elements. `spiceEngine="pcb_spice"` selects this local runner. The entry exports `modeling` to describe selected routes, stackup, conductor/return geometry, materials, and extraction settings.

Models use `IbisModelDefinition` from `@tscircuit/props`. Their `ibisModelAsset.project_relative_path` points to an extracted `.ibs` file relative to the project root. The runner reads it first, then can fall back to an HTTP(S) asset URL. `pnpm simulate:models` prepares the repository's files; `modeling.ibisModelAssetSha256` declares their expected byte hashes.

Physical IBIS pin names map to TSX labels through `ibisPinNameToPortLabel`. Buffer selections, reference rails, `modelValueCorner`, and `includePackageParasitics` are explicit. Use selectors such as `chip.U1` when BGA pin names could also match `.U1`.

For saved boards, put native simulation declarations inside `<ImportedBoard circuitJson={savedBoard}>`, imported from `pcb-spice-pipeline/tsx`. See the [DDR example](examples/ddr-dq/index.circuit.tsx). The bridge preserves original physical records and verifies referenced pin/net mappings. Additional physical children, ambiguous bindings, and existing saved simulation declarations/results are rejected. To run an existing Circuit JSON simulation, export `circuitJson` and `modeling` directly.

The project pins matching PR previews of [core](https://github.com/tscircuit/core/pull/4765), [props](https://github.com/tscircuit/props/pull/945), and [Circuit JSON](https://github.com/tscircuit/circuit-json/pull/908). Use the checked-in lockfile.

</details>

<details>
<summary>Build checks, tests, and tool installation paths</summary>

```sh
pnpm typecheck
pnpm build
pnpm test:native
pnpm simulate:prove
```

`test:native` requires prepared models and installed solvers. It checks the full three-signal complex network, vendor fixtures, received data histories, startup, probe associations, and eye gates. `simulate:prove` runs all four examples twice with fresh solves and independent audits. Unit tests use `pnpm test` and additionally require Bun; normal simulation does not.

Tools normally live under `node_modules/.cache/pcb-spice-pipeline/tools`. `PCB_SPICE_CACHE` changes the runtime cache location. For an explicit tools installation:

```sh
pnpm simulate:setup --tools-dir /absolute/path/to/tools
PCB_SPICE_TOOLS=/absolute/path/to/tools/tools.json pnpm simulate:ddr-dq --open
```

Setup verifies pinned source revisions, executable hashes, and installed runtime libraries. Local/user ngspice startup files are ignored and runtime-library overrides are rejected. See the [toolchain lock](packages/pcb-spice-pipeline/toolchain-lock.json) for sources and licenses. Vendor files are fetched locally and are not redistributed in the repository.

</details>

<details>
<summary>What the simulation includes and leaves out</summary>

The backend supports **one to three selected coupled channels** and unswept transient experiments. It retains mutual R/L/C coupling and an explicit finite return conductor. Unused traces are visible in the report but are not included in the electrical solve.

Routed lengths and widths are straightened into stages with assumed spacing, homogeneous effective dielectric, and fixed-frequency R/L. Full planes, unselected nearby nets, dielectric loss, copper roughness, complete via pads/stubs, and the board PDN are omitted. Reference rails use explicit ideal supplies. The DDR comparison assumes uniform 0.75 mm center spacing and continuous write-direction pad/channel activity. Controller logic, commands, bursts, training, and clock recovery are not modeled. The source board is an incomplete saved routing checkpoint; preview represents saved footprints as generic chips.

These are finite observed transient eyes, without BER extrapolation, protocol compliance, or a hardware accuracy claim. IBIS currents outside characterized voltage ranges hold the endpoint current, with that approximation recorded. The unterminated CMOS fixture rings above its 3.3 V rail and its selected input lacks a power-clamp table; the raw excursions remain visible and do not establish a safe interface. Package parasitic omissions are recorded in the receipt.

</details>
