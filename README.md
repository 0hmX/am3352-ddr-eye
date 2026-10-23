# IBIS + PCB simulation in tscircuit

These five TSX examples attach real vendor IBIS pad models to PCB channels and declare transient experiments, digital stimulus, voltage probes, and eyes using normal tscircuit elements. `tsci simulate analog` renders the circuit and calls `@tscircuit/pcb-spice-pipeline` as an in-memory library. The CLI owns local files, native solver execution, and report output.

**Routed DDR remains blocked by a recorded FastHenry numerical failure.** The downloadable report and measurements below describe the historical straightened-strip model, which uses different return geometry. They do not establish routed-board success, DDR compliance, or BER.

## Install and prepare inputs

Use Node.js **22.13 or newer** and pnpm **11.25.0**, then run from this repository:

```sh
pnpm install --frozen-lockfile
pnpm simulate:models
pnpm typecheck
pnpm test
```

This branch resolves `@tscircuit/core`, `@tscircuit/props`, `circuit-json`, `@tscircuit/cli` and `@tscircuit/pcb-spice-pipeline` from **local sibling checkouts** (`file:../core`, `../props`, `../circuit-json`, `../cli`, `../pcb-spice-pipeline`) through `package.json` and the `pnpm-workspace.yaml` overrides. Those checkouts carry the `pcbSpiceChannel` prop, the `simulation_experiment.pcb_spice_channel` record, `ibis_model_asset.sha256`, and the pipeline/CLI that derive modeling from Circuit JSON. Build each sibling (`bun run build` / `pnpm build`) before `pnpm install`; switch back to published versions once those changes are released. The existing fanout-solver declaration workaround still runs during installation.

`simulate:models` explicitly downloads the four vendor archives into a local cache, checks their SHA-256 hashes, extracts only the locked IBIS members, checks their hashes, and writes `models/`. [DDR vendor locks](vendor-models.json) and [CMOS/RS-485 locks](examples/vendor-models.lock.json) retain their source URLs and checksums. Vendor model bytes are not redistributed. Simulations read these prepared local assets; the library does not fetch missing models.

Install **FastHenry, FasterCap, and ngspice separately** before a native run. The CLI uses installed executables; programmatic callers can supply absolute executable paths through the Node adapter shown below. Installation of compiler dependencies or solver binaries is outside this repository's simulation commands. The library never installs tools, downloads vendors, or enforces a build receipt. Native tools remain an external prerequisite; an in-process/WASM replacement has not been validated for this pipeline's coupled extraction and IBIS decks.

For executables outside PATH, set `PCB_SPICE_TOOLS` to a JSON file containing their absolute `fasthenry`, `fastercap`, and `ngspice` paths. Existing tool maps can be supplied explicitly through this variable.

## Run an example

```sh
pnpm simulate:ddr-dq-strip --output .tscircuit/ddr-strip
```

This invokes `tsci simulate analog examples/ddr-dq-strip/index.circuit.tsx`. Open the generated `results.html` and keep its `csv/` folder beside it. Use a fresh output directory for another run. Reports, waveforms, Circuit JSON results, and solver artifacts are written by the CLI after an explicit simulation request.

| Circuit | Command | Electrical model |
| --- | --- | --- |
| [Root](index.circuit.tsx) | `pnpm simulate` | AM3352 DQS/DQSn, original routed copper; subject to the known FastHenry blocker |
| [DDR DQ](examples/ddr-dq/index.circuit.tsx) | `pnpm simulate:ddr-dq` | Routed DQ0 + DQS/DQSn, quiet/switching experiments; recorded FastHenry failure |
| [Historical DDR strip](examples/ddr-dq-strip/index.circuit.tsx) | `pnpm simulate:ddr-dq-strip` | Straightened stages, assumed spacing, artificial finite return strips |
| [CMOS](examples/single-ended/index.circuit.tsx) | `pnpm simulate:single-ended` | SN74LVC1G04 output-pad/input-pad channel, explicit 20-Mbps data |
| [RS-485](examples/differential-data/index.circuit.tsx) | `pnpm simulate:non-ddr` | SN65HVD72 pair, 120-ohm termination, explicit 250-kbps data |

Append `--output <directory>` to select a report directory. The equivalent direct invocation is:

```sh
pnpm exec tsci simulate analog examples/ddr-dq-strip/index.circuit.tsx --output .tscircuit/ddr-strip
```

`tscircuit.config.json` disables the parts engine for this project. `pnpm dev` previews the circuit design; `pnpm build` builds it with the parts engine disabled. Neither command runs the native PCB simulation. The former standalone pipeline setup, repeat, and compare commands have been removed.

## Programmatic caller

Mount the board once through core's normal React renderer, then use the supported serializer. This retains saved physical geometry and pin IDs while attaching native simulation declarations and the generated stackup:

```ts
import { Circuit } from "@tscircuit/core"
import { runPipeline } from "@tscircuit/pcb-spice-pipeline"
import { serializeSimulation } from "@tscircuit/pcb-spice-pipeline/tsx"
import {
  createNativeSolver, loadIbisSources, writePipelineOutput,
} from "@tscircuit/pcb-spice-pipeline/node"
import { createElement } from "react"
import Board from "./examples/ddr-dq-strip/index.circuit"
import project from "./tscircuit.config.json"

const circuit = new Circuit({ platform: project.platformConfig })
circuit.add(createElement(Board))
await circuit.renderUntilSettled()
const circuitJson = serializeSimulation(circuit)
const ibisSources = await loadIbisSources({ circuitJson, baseDir: process.cwd() })
const runSolver = createNativeSolver({ tools: {
  fasthenry: "/absolute/path/to/fasthenry",
  fastercap: "/absolute/path/to/FasterCap",
  ngspice: "/absolute/path/to/ngspice",
} })
// Modeling is derived from the serialized pcb_spice_channel declarations.
const result = await runPipeline({ circuitJson, ibisSources, runSolver })
await writePipelineOutput({ result, outputDir: ".tscircuit/programmatic-strip" })
```

The root import accepts Circuit JSON (an explicit `modeling` object is now an optional override), caller-resolved IBIS bytes keyed by `ibis_model_asset.project_relative_path`, and a `runSolver` capability. It returns structured matrices, experiments, waveforms/eyes, assessments, limitations, `simulationResultCircuitJson`, and artifact strings in memory. `generateReport(result)` returns HTML/CSV file contents without writing them. A caller can merge results, save selected artifacts, or display them in another UI.

Only the explicit `/node` import performs local asset reads, requested native processes, and requested output writes. A custom `runSolver` can own another execution environment, but must return genuine validated extraction/transient output. Missing assets, unsupported models, incomplete solver results, and convergence failures remain errors; approximate matrices are not an implicit fallback. `/tsx` is the optional React/core adapter, separate from the main library.

## Authored inputs

Everything a run needs is declared in TSX and serialized into Circuit JSON; entries no longer export a `modeling` object, and there is no `simulation.config.ts`, `simulation.json`, `board-construction.json` or `profiles.json`.

| Input | Purpose |
| --- | --- |
| [Circuit TSX](examples/ddr-dq/index.circuit.tsx) | IBIS bindings, pad states, transient timing, stimulus bits, probes, eyes, and the `pcbSpiceChannel` prop on `<analog.transientsimulation>` |
| [DDR buffers and routed channel](ddr-buffers.ts) | AM3352/Winbond IBIS bindings with model `sha256`, and the shared routed-copper `pcbSpiceChannel` |
| `<voltagesource name="VDDQ">` | Ideal 1.5 V rail between `U1.E5` and `U1.A1`; inside `ImportedBoard` it is simulation-only and is remapped onto the saved pads (replaces `modeling.supplies`) |
| [Saved board](am3352.circuit.json) | Original 100 × 80 mm PCB geometry, physical IDs, 750 traces, 835 vias, 27 pours, and pre-existing diagnostics; `fabricatorPreset="jlcpcb_standard"` makes core emit the four-layer JLC `pcb_stackup` |
| [Source provenance](source-provenance.json) | Board attribution, input hash, evidence, assumptions, and limitations (documentation only) |

`pcbSpiceChannel` holds the settings Circuit JSON could not express before: `reduction`, `sections`, ordered `lanes` (`from`/`to` port selectors), `referencePinRef` (SPICE ground), `passiveComponentRefs`, `extraction` (frequencies, filaments, tolerances, `maxPanelLength`, `groundMeshSize`), `relativePermittivity`, `via` approximations, and, for `straightened-stages` only, `straightenedStageProfiles`. Core resolves the selectors to `source_port_id`s and writes `simulation_experiment.pcb_spice_channel`; the pipeline's `modelingFromCircuitJson` reads it back. All `pcb_spice` experiments in one entry must declare the same channel because they share one extraction. `tsci simulate analog --modeling <file>` still overrides it.

The straightened-strip profiles (CMOS, RS-485, historical DDR strip) remain declared assumptions, not board geometry: uniform signal pitch, an artificial finite return strip per layer and a homogeneous εr. Routed DDR omits other ground routing and stitching, unselected nets and power copper, via pads/antipads/stubs, dielectric loss, copper roughness, broadband R/L dispersion, PDN impedance and package parasitics.

Saved-board examples import `ImportedBoard` from `@tscircuit/pcb-spice-pipeline/tsx` and put simulation children inside it. Always call `serializeSimulation(circuit)` for these examples: ordinary `getCircuitJson()` contains an inflated preview rather than the preserved saved records. Additional physical children and ambiguous simulation bindings are rejected. Selectors such as `chip.U1` disambiguate chip names from BGA pin names.

DDR drives `U1.M3/P1/P2` into `U3.E3/F3/G3`. The TI `sprm552c.ibs` component `am335x_zcz` uses `Model_343`, `Model_655`, and `Model_847`; the Winbond receiver uses `W631GG6MB-12.ibs`, component `W631GG6MB-12`, model `ODT_60`. Physical reference pins bind supplies and ground explicitly. IBIS describes pad behavior; chip logic is outside these experiments.

DQ0 repeats `00010111` at 2.5 ns/bit (400 MT/s). Quiet and switching experiments keep victim traffic, rails, pad models, and geometry identical while changing DQS/DQSn traffic. Six voltage probes and four eyes are declared across the two experiments. The DQ eye skips 40 ns and retains complete two-UI windows inside 40–160 ns, folded on the declared stimulus clock with linear interpolation and no artificial jitter. Received DQS alignment, VREF thresholds, setup/hold masks, BER extrapolation, and compliance are outside this result.

## Recorded results and routed blocker

**[Download the historical strip report: HTML + CSV](assets/simulation-api/ddr-report.zip?raw=1).** It was regenerated on 2026-10-21 using straightened stages and finite return strips with JLC construction emitted as `pcb_stackup`. Choose **Plots → DDR_SWITCHING → DQ0_RX → Eye** in the report.

[![Historical strip-model DQ0 receiver eye](assets/simulation-api/ddr-eye.png)](assets/simulation-api/ddr-eye.png)

| Historical strip result | Value |
| --- | --- |
| DQ0 / DQS / DQSn route lengths | 45.044 / 45.046 / 45.168 mm; two vias each |
| Transient duration / maximum step | 160 ns / 10 ps per experiment |
| Adaptive timestamps | 45,786 quiet / 163,305 switching |
| DQ0 eye | 46 complete windows; 2.5 ns UI; 40–160 ns gate |
| DQ0 receiver range, quiet | 0.219821–1.296174 V |
| DQ0 receiver range, switching | 0.219400–1.297027 V |
| Peak absolute switching − quiet difference | 6.054232 mV |
| Time RMS difference | 1.594924 mV |

These historical measurements use assumed 0.75 mm signal spacing, artificial 2 mm × 35 µm return strips, and 1.5 V ideal supplies. [Recorded inputs, dependency pins, measured values, and CSV hashes](assets/simulation-api/ddr-run.json) describe that run; they are not fresh migration-validation results. Historical receipts in downloaded artifacts are evidence from the old runner, not a prerequisite of the programmatic library.

The separate [routed-copper validation](assets/simulation-api/ddr-routed-validation.json) fails in FastHenry stage 0 with `Huh?  filament not expected length` and `mutual inductance = infinity`. Two 10.469 µm rounded-route edges reproduce a floating-point projected-length failure. No routed DQ0_RX eye windows or voltage range are available. This migration preserves that limitation and does not substitute strip results for routed results.

## Modeling limits and validation

The backend supports one to three selected coupled channels and unswept transients. Routed DDR follows original signal coordinates and connected ground pours, with ground polygons/cutouts approximated by a mesh for FastHenry. FasterCap uses homogeneous dielectric assumptions. Geometry, units, finite positive matrices, reciprocity, passivity, and convergence remain validated by the pipeline. A failed solver does not produce a successful assessment.

Fixed-frequency R/L and extracted C are distributed into uniform sections; broadband dispersion, dielectric loss, copper roughness, unselected neighbors, complete package/PDN effects, and receiver logic remain outside the established model. Rails are ideal; selected IBIS package parasitics are omitted explicitly. CMOS and RS-485 use straightened stages and finite return strips. The saved DDR board is an incomplete routing checkpoint with existing unconnected-port diagnostics.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm test:native
```

`pnpm test` renders all five examples through normal core mounting and the public serializer, without native solvers or vendor downloads. It checks the fabrication stackup, all saved physical records/IDs, simulation declarations, probe/experiment references, and millisecond timing. `test:native` requests the historical strip simulation and requires prepared models and installed solvers; it does not validate routed DDR. Native or WASM parity should only be claimed after separate analytical and converted-IBIS deck comparisons.
