# tscircuit local signal-integrity simulation

Author ordinary tscircuit TSX, run the native simulation locally, and inspect interactive waveforms and eyes. The project uses published tscircuit/core/props/Circuit JSON releases and workspace TypeScript libraries. No experimental dependency tarballs or Python are required.

External programs are **not bundled**. A separate setup command downloads and builds pinned, unmodified FastHenry, FasterCap and ngspice sources into the user's cache. Simulation refuses to run until that installation exists and passes its provenance checks. `pnpm install`, preview and ordinary circuit build never install the solvers.

## Install and run

Use Node 22 or newer and the project's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm dev
```

For native setup, install Git, curl, make, C/C++, CMake and bzip2. macOS additionally needs Xcode command-line tools, Homebrew LLVM and libomp. Linux needs build-essential, bison and flex. Setup can install the documented system dependencies through Homebrew or apt when explicitly requested:

```sh
pnpm simulate:setup --install-deps
# With prerequisites already installed, use: pnpm simulate:setup
pnpm exec pcb-spice-pipeline --check-tools
pnpm exec pcb-spice-pipeline examples/single-ended/index.circuit.tsx --out .tscircuit/cmos --open
```

`--open` opens the generated `results.html` in your default browser. The page also works offline when opened directly. Select a probe or experiment, switch between waveforms and eyes, overlay experiments, scroll to zoom, drag to pan, or enter an exact time range. The cursor reports an actual adaptive solver sample. Display envelopes retain sample extrema; analysis always uses the full recorded samples. Raw CSV remains available beside the page.

The default installation is under `node_modules/.cache/pcb-spice-pipeline/tools`. Set `PCB_SPICE_CACHE` to keep a shared cache elsewhere. For an explicit installation directory:

```sh
pnpm exec pcb-spice-pipeline --setup --tools-dir /absolute/path/to/tools
PCB_SPICE_TOOLS=/absolute/path/to/tools/tools.json pnpm simulate:ddr-dq
```

Setup records source revisions/checksums, build commands, executable hashes and installed runtime libraries. Local/user ngspice startup files are ignored. Runtime-library overrides are rejected. Solver sources and manufacturer model files stay in the local cache, outside package contents; their upstream notices and licensing terms remain applicable. See `packages/pcb-spice-pipeline/toolchain-lock.json` for the pinned sources and license details. macOS arm64 is the exercised native platform; Linux setup is supported but needs its own platform validation.

## TSX declarations

Import `si` from `pcb-spice-pipeline/tsx`. It works alongside normal `<board>`, `<chip>`, `<trace>` and `<voltagesource>` elements:

```tsx
import { si } from "pcb-spice-pipeline/tsx"

// Within the board, after defining TX/RX and routing their physical ports:
<si.Model componentRef=".TX" {...outputPad} />
<si.Model componentRef=".RX" {...inputPad} />
<si.Transient name="SI" duration="1600ns" timePerStep="50ps"
  ibisPinStates={{
    ".TX > .Y": { mode: "output", enabled: true },
    ".RX > .A": { mode: "input" },
  }} />
<si.Stimulus name="DATA" simulationRef=".SI" drives=".TX > .Y"
  unitInterval="50ns" startTime="0ns" initialState={0}
  pattern={{ type: "bits", bits: "001110100101011000101101", repeat: true }} />
<si.Probe name="RX" connectsTo=".RX > .A" referenceTo=".RX > .GND" />
<si.Eye name="RX_EYE" simulationRef=".SI" probeRef=".RX"
  unitInterval="50ns" timeOrigin="0ns" startTime="200ns" />
```

The workspace uses a standard TypeScript path alias for `pcb-spice-pipeline/tsx`, pointing preview/evaluation at the browser-safe source entry. Installed consumers can use the compiled package subpath.

The entry also exports `modeling`: explicit selected routes, physical stackup, conductor/return geometry, material assumptions and extraction settings. See `examples/single-ended/index.circuit.tsx` and its configuration for a complete runnable design.

The local CLI renders the TSX and serializes the adapter's declarations with resolved physical source-port IDs. Ordinary `tsci dev`/`tsci build` render the physical circuit only; the `si` declarations do not run, fetch models or invoke a solver during preview. These additional SI records are validated by this package's extension schemas; they are not yet registered in upstream Circuit JSON.

Model definitions are typed by `@tscircuit/ibis-to-spice`. Sources accept exactly one of `{url, sha256}`, `{file, sha256?}`, or `{content, sha256?}`. Archives require an exact member. `source.sha256` covers original downloaded/file/content bytes; `archive.memberSha256` covers the extracted IBIS member. Physical IBIS pin numbers map explicitly to TSX port labels; models, corners, reference rails and output enable states are explicit.

For saved Circuit JSON, `<si.ImportedBoard circuitJson={savedBoard} />` preserves the original records for simulation. Use SI declarations as siblings of this element. In ordinary PCB preview, saved footprints are represented as generic chips to avoid reinterpreting the snapshot through the published component inflators and placement DRC is skipped for this read-only snapshot preview; the saved original routing/electrical data is used by the simulation. Imported selectors currently support unambiguous `.COMPONENT > .PORT` references. Newly authored TSX uses the normal core selector engine. Probe/experiment names must be unique across an entry, and each experiment stays in one subcircuit.

The published fanout-solver dependency exports implementation TypeScript as its typings. `scripts/prepare-types.mjs` emits development declarations into `node_modules/.cache` so our strict checks cover our code without compiling that unrelated dependency under different settings. Its runtime package is unmodified.

## Experiments and comparison

```sh
pnpm simulate:single-ended
pnpm simulate:non-ddr
pnpm simulate:ddr-dq
pnpm exec pcb-spice-pipeline examples/ddr-dq/index.circuit.tsx --out .tscircuit/ddr
pnpm exec pcb-spice-pipeline --compare .tscircuit/ddr --probe DQ0_RX --out .tscircuit/comparison --open
pnpm exec pcb-spice-pipeline --repeat examples/single-ended/index.circuit.tsx --out .tscircuit/repeat
```

The DDR example compares `DDR_QUIET` with `DDR_SWITCHING`: victim traffic, vendor models/states, rails, probes, geometry and all coupled R/L/C terms stay identical. Only selected neighbor traffic changes. Each experiment runs one native transient shared by all its probes and eyes. Comparison verifies saved artifact hashes and matching electrical conditions. It currently requires a ground-referenced single-ended victim. Differences use piecewise-linear reconstructions on the union of adaptive timestamps; RMS is integrated over time. Both simulation and comparison produce an interactive `results.html` without a plotting subprocess.

Outputs include exact inputs and vendor bytes, geometry and matrices, generated SPICE decks, native commands/logs, `waveform.csv`, probe-bound `circuit-results.json`, eye CSV/folding metadata, `results.html`, and a hash-bound `receipt.json`. Comparison adds `comparison.json`. Repetition runs two fresh solves and compares numerical artifacts. Generated results remain local and are ignored by Git.

## Scope and validation

The backend supports one to three selected coupled channels and unswept transient experiments. It rejects unsupported fanout, ambiguous/duplicate endpoint selections, absent IBIS states/references, incomplete/nonfinite matrices, and failed passivity/convergence checks. It retains full mutual R/L/C coupling and the explicit finite return conductor.

The backend straightens routed lengths/widths into stages with assumed signal spacing, homogeneous effective dielectric and fixed-frequency R/L. Bends, complete planes, unselected nearby nets, dielectric loss, copper roughness, complete via pads/stubs and the board PDN are omitted. Selected reference rails use explicit ideal supplies. The DDR DQ0/DQS/DQSn experiment assumes uniform 0.75 mm center spacing. It models continuous write-direction pad/channel activity, with fixed timing origin; commands, bursts, training and memory/controller logic are omitted. The original AM3352 board is an incomplete saved routing checkpoint, not a fabrication-ready or independently measured reference.

These are finite observed transient eyes, with no implicit traffic, clock recovery, random jitter, BER extrapolation, protocol compliance or hardware accuracy claim. IBIS currents outside characterized table voltage ranges hold the endpoint current; this approximation is recorded in converter metadata. The unterminated CMOS fixture rings above its 3.3 V rail (about 5.63 V); its selected input has no power-clamp table. Full raw excursions are retained, including startup; that fixture does not establish a safe interface. Package parasitics are omitted where vendor data cannot be represented by this backend, and omissions appear in the receipt.

```sh
pnpm test
pnpm test:native
pnpm simulate:prove
```

Native tests require installed tools and fresh solves. They verify the complete three-signal complex network, real vendor fixtures, received data histories, raw startup, probe associations and eye gates. Verification tools under `scripts/verification` independently audit the saved numerical artifacts.
