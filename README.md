# tscircuit IBIS / SPICE examples

One normal tscircuit project, with a TSX entrypoint, the standard `tsci dev` preview and `tsci build` output. The reusable converter and PCB simulation CLI live in `packages/`; experimental tscircuit dependencies and their source patches live in `.packages/`. There is no CI or LLM in the runtime workflow.

| Example | Board and real vendor models | Signal and stimulus |
| --- | --- | --- |
| `index.circuit.tsx` | Published **astra/am3352-sbc v0.1.19** routing; TI AM335x + Winbond W631GG6MB-12 | DDR DQS differential clock, 2.5 ns UI |
| [`examples/ddr-dq/index.circuit.tsx`](examples/ddr-dq/index.circuit.tsx) | Same routed AM3352 board and vendor sources | DDR DQ0 with all eight three-bit histories and differential DQS strobe, 2.5 ns UI |
| [`examples/ddr-routed/index.circuit.tsx`](examples/ddr-routed/index.circuit.tsx) | Same saved routes, reference pours, stackup and TI/Winbond models | Lower byte, DQS pair and adjacent DM1/D9/CKE; 14 signals with quiet and switching neighbors |
| `examples/differential-data/index.circuit.tsx` | Designed routed fixture; TI SN65HVD72D | RS-485 differential arbitrary data, 4 us UI; differential and A-to-ground eyes |
| `examples/single-ended/index.circuit.tsx` | Designed routed fixture; TI SN74LVC1G04_DCK | Single-ended CMOS output-pad data, 50 ns UI; TX and RX eyes |

All examples use the same API, converter, extraction and native solver pipeline. Multiple eyes share the waveform from their declared transient experiment. The two non-DDR fixtures contain real footprints, native manually routed traces, explicit voltage sources and board construction. They are pad/channel experiments, not complete functional products or independently validated boards.

## Run locally

Install Node.js 22 or later, pnpm **11.25.0**, and Bun (the standard pinned `tsci` launcher and converter tests use Bun).

```sh
git clone https://github.com/0hmX/am3352-ddr-eye.git
cd am3352-ddr-eye
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm dev --port 3091
```

Open the ordinary file selector to preview any example TSX. Generated `dist/**` files are ignored by the dev server so saved simulation output does not enter its source watcher. Supplier metadata lookup is disabled in `tscircuit.config.json`; the build uses the standard `--disable-parts-engine` flag.

For simulation, also install Python **3.11**, Git and a C/C++ compiler. macOS needs Homebrew and Xcode command-line tools. Setup builds pinned FastHenry, FasterCap and ngspice and installs the pinned plotting environment. Setup installs native dependencies through Homebrew on macOS or apt on Linux; this delivery was executed on macOS arm64.

```sh
pnpm simulate:setup
pnpm simulate
pnpm simulate:ddr-dq
pnpm simulate:non-ddr
pnpm simulate:single-ended
```

The shared CLI defaults to a 15-minute wall-clock limit per native job. The heavier `simulate:ddr-routed` script sets one hour per job; its full workflow runs several jobs in sequence. Set `PCB_SPICE_TIMEOUT_MS` when calling the CLI directly to choose another limit. Every command receipt records the applied limit. Keep the host awake during native runs; on macOS, `caffeinate -i pnpm simulate:ddr-routed` prevents idle sleep for that command. Forced sleep or closing the lid can still interrupt it.

Run all four twice, in separate processes with fresh native solver output:

```sh
pnpm simulate:prove
```

The command prints the fresh proof directory under `dist/`. Each case contains `run-a/`, `run-b/` and `repeatability.json`; the top-level `proof.json` records all four results. The same command independently checks every waveform/eye sample, vendor/geometry/matrix provenance, invalid declarations and shifted eye timing. Vendor/model downloads and installed tools can be cached; solver results are never reused. Existing output directories are rejected.

```sh
pnpm test
pnpm test:native
```

`pnpm test` fetches hash-locked real vendor fixtures, then runs converter and pipeline tests. `test:native` executes the DDR DQ0, non-DDR and single-ended examples and checks serialized results and rejected declarations.

The [DDR DQ0 example](examples/ddr-dq/index.circuit.tsx) is a single TSX file. It declares the vendor models, pin mapping, board construction, DQ0 traffic, DQS strobe, probes and eyes. The standard library CLI runs the simulation and generates the plots:

```sh
pnpm simulate:ddr-dq
# Optional fresh repeated runs:
pnpm simulate:ddr-dq --repeat --out dist/my-ddr-dq-proof
```

The printed output directory is under ignored `dist/`. Each `experiments/<id>/` contains `waveform.csv` and `waveform.png`; each `eyes/<id>/` contains `eye-data.csv` and `eye.png`. Plotting is implemented once in `pcb-spice-pipeline`, shared by every example. Generated plots and solver receipts are not checked in.

The routed example uses the same converter, transient solver, probes and plotting library. Its `reduction: "routed-shapes"` mode passes physical geometry from the pinned `circuit-json-to-gmsh` package to native FastHenry and FasterCap. The saved reference copper is **GND on bottom and DDR_1V5 on top**, with recorded voids, pads and drills; the selected signals retain their actual XY paths, widths, layer changes and barrel spans. The impedance plane mesh uses a 0.5 mm target size, with a 1 µm surface tolerance followed by a 25 µm boundary tolerance. Capacitance uses zero-thickness sheets at the foil/barrel midplanes, a 3 µm surface tolerance, 2 µm coordinate grid and quality triangular mesh with 0.5 mm target size. Via plating is explicitly assumed to be 25 µm.

Run a controlled comparison with fresh output directories:

```sh
pnpm simulate:setup
pnpm simulate:ddr-dq --out dist/reduced
PCB_SPICE_TIMEOUT_MS=3600000 pnpm simulate:ddr-routed --out dist/routed
pnpm exec pcb-spice-pipeline compare dist/reduced dist/routed \
  --probe DQ0_RX --sampling-probe DDR_RX --threshold 0.75 --out dist/comparison
# Optional: execute the entire routed workflow twice, sequentially:
PCB_SPICE_TIMEOUT_MS=3600000 pnpm simulate:ddr-routed --repeat --out dist/routed-proof
```

`dist/comparison/` contains waveforms, fixed-clock eyes, receive-DQS-aligned eyes and a manifest bound to the input receipts and waveforms. Quiet and switching experiments use identical DQ0 traffic, DQS timing, vendor settings, probe and eye gate. The ten neighboring data/mask outputs are held low in `QUIET`; in `SWITCHING` they simultaneously drive the complement of DQ0, an explicit switching stress pattern. CKE stays high in both cases. Sampling uses actual received DQS crossings; 0.75 V is an explicit analysis threshold. This is a continuous write-direction pad/channel test. `PCB_SPICE_THREADS` controls OpenMP threads and is recorded in each solver command. Default is one thread.

The selection includes the lower byte plus physical neighbors from the saved routing. DM1 (U1.J2 → U3.D3), CKE (U1.G3 → U3.K9) and D9 (U1.K1 → U3.C3) follow DQ0 on inner1 for approximately 7.56, 5.53 and 2.40 mm within a 0.5 mm copper-edge gap. DM1/D9 use TI `Model_343` and Winbond `ODT_60`; CKE uses TI `Model_343` and Winbond `CMD` input loading. The extra probes expose actual DM1/D9 receiver waveforms. Other board signals remain outside this selected experiment.

The routed capacitance solve uses Galerkin integration. Extremely weak mutual terms can have the wrong sign at finite numerical resolution. The example explicitly permits a bounded Maxwell correction: preserve row sums and add a positive-semidefinite correction that removes only positive mutual terms. The receipt retains the raw matrix, correction, corrected pairs and a conservative relative energy bound, which must be at most 0.1%. A converged coarse matrix that passes the raw physical checks but exceeds only this correction budget can serve as a raw refinement reference; it cannot be used as the final electrical model. This does not establish that the unresolved terms converged. Whenever the final matrix requires a nonzero correction, the library also executes an additional diagnostic transient with the uncorrected symmetric matrix, retaining every signed mutual term, and requires every probe's recorded waveform to change by at most 1 mV. Raw solver convergence, reciprocity, passivity and mesh refinement checks remain required; neither the energy budget nor waveform sensitivity bounds physical modeling error.

This backend is experimental: it extracts **whole-route quasistatic matrices**, then homogenizes them into a uniform 32-section coupled ladder. Capacitance uses explicit **homogeneous εr=4.1**; dielectric interfaces, air inside drill holes and finite copper thickness are not solved by that approximation. Impedance retains finite copper thickness, with reference foil currents approximated by a triangular sheet-to-filament mesh. Cross-section current distributions and frequency dependence have not been converged. The extraction saves normalized inductive, electrostatic and resistive coupling plus an ideal-line consistency comparison; these are diagnostic clues, not accuracy bounds or measured modal delays. Source/receiver rails use all 84 declared, vendor-verified digital-ground and DDR-supply contacts: U1 has 38 digital VSS and 7 VDDS_DDR balls, and U3 has 21 VSS/VSSQ and 18 VDD/VDDQ balls. Each chip's selected digital grounds and DDR supplies are ideal package nodes with ideal incremental AC joins. Separate analog/RTC/USB/oscillator ground domains, PLL_DDR and other supplies are excluded from these ideal terminal joins. This still omits package and board PDN impedance. The remaining board signals, package impedance, power-distribution noise, dielectric loss, radiation and spatial variation of coupling are outside this model. The declared construction is a selected fabrication-stackup assumption, not a measurement of this board. Mesh/crop sensitivity and correlation with an independent solver or measurement are needed before claiming hardware accuracy. A changed simulated eye alone does not establish that the new prediction is accurate.

DQ0 uses the routed U1.M3 → U3.E3 connection, TI `Model_343` and Winbond `ODT_60`; DQS retains U1.P1/P2 → U3.F3/G3 with TI `Model_655/847`. The shared hash-locked model sources remain active. DQ0 repeats `00010111` at a 2.5 ns UI; DQS alternates with a 1.25 ns offset. The native integration tests sample received DQ at both polarities of the received DQS crossing and require all eight three-bit histories in both the sampled data and eye windows.

## General TSX API

A chip's `ibisModel` is reusable electrical data. It does not contain traffic or eye settings:

```tsx
<chip name="TX" pinLabels={pins} footprint={<Soic8Pads />}
  ibisModel={<ibismodel
    source={{ url: vendorUrl, sha256: archiveHash,
      archive: { member: "model.ibs", memberSha256: modelHash } }}
    component="SN65HVD72D"
    pinMap={{ "6": "A", "7": "B", "8": "VCC", "5": "GND" }}
    modelSelections={{ "6": "a_b_p", "7": "a_b_n" }}
    references={{
      "6": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" },
      "7": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" },
    }}
    corner="typical" packagePolicy="omit"
  />} />
```

`source` accepts one of `{url, sha256}`, `{file, sha256?}`, or `{content, sha256?}`. Local file paths are relative to the board entrypoint directory (or absolute), including definitions imported from shared modules. Archives require an exact member; URL resources require content hashes in this repeatable pipeline. Physical IBIS pin numbers map explicitly to local TSX port labels. Model selectors, corner and reference rails are explicit. A standalone `<ibismodel componentRef=".U1" {...definition} />` attaches the same definition to a chip on an imported board without changing its routing.

`source.sha256` checks the original bytes downloaded from `url`, read from `file`, or supplied as UTF-8 `content`, before any extraction. For ZIP sources this is the ZIP checksum; `archive.memberSha256` checks the extracted member separately. For a direct `.ibs` resource, omit `archive` and put the IBIS checksum in `source.sha256`. The former `archive.sha256` key is rejected; migrate both the field name and the two checksum values together.

A transient experiment owns buffer state and enabled/disabled output state. Digital stimuli own the bit sequence; probes own the electrical quantity; eyes own folding and observation time:

```tsx
<analog.transientsimulation name="SI" duration="128us" timePerStep="5ns"
  ibisPinStates={{
    ".TX > .A": { mode: "output", enabled: true },
    ".RX > .A": { mode: "input" },
  }} />
<analog.digitalstimulus name="DATA" simulationRef=".SI" drives=".TX > .A"
  unitInterval="4us" startTime="0us" initialState={0}
  pattern={{ type: "bits", bits: "0011101001010110", repeat: true }} />
<voltageprobe name="RX_V" connectsTo=".RX > .A" referenceTo=".RX > .GND" />
<analog.eyediagram name="RX_EYE" simulationRef=".SI" probeRef=".RX_V"
  unitInterval="4us" timeOrigin="0us" startTime="16us" endTime="128us" />
```

This fragment shows one leg; the complete RS-485 example declares both outputs, both input states and the second inverted stimulus. `inverted` changes the logical initial state and bits once; vendor Polarity is applied separately. Single-ended and differential measurements use the same probe: choose ground or another signal for `referenceTo`. Multiple eyes can reference the same experiment and waveform.

Use explicit time strings. Bare numeric times in the general `analog.*` API mean **milliseconds**, matching tscircuit/Circuit JSON. Numeric times in the retained legacy bare `<eyediagram>` API mean seconds. The new examples use only the general API.

Eye boundaries are `b_k = timeOrigin + k * unitInterval` for integer k. A complete window spans `[b_k - UI/2, b_k + 3*UI/2]` inside the explicit observation gate. The pipeline interpolates actual adaptive solver samples; it does not fit the origin to receiver crossings or divide alternating windows into artificial data classes.

## Pipeline and evidence

The workflow renders ordinary TSX to registered Circuit JSON declarations, extracts selected saved PCB routes, runs FastHenry for coupled R/L and FasterCap for C, assembles real vendor I/V/clamp/die-capacitance/switching tables with explicit sources and passives, executes the declared native ngspice transient, then folds every eye from its referenced probe. Any extra capacitance sensitivity transient is recorded separately from that experiment's waveform and eyes.

Each run includes:

- `inputs/circuit.json`, `inputs/modeling.json` and exact downloaded IBIS/archive bytes.
- `geometry.json`, field-solver inputs/logs and R/L/C matrices, plus `channel.cir`.
- `experiments/<id>/simulation.cir`, model libraries, actual solver command/logs and `waveform.csv`/`waveform.png`.
- `experiments/<id>/eyes/<id>/eye.png`, `eye.svg`, `eye-data.csv` and folding metadata.
- `circuit-results.json`: registered probe-bound transient graphs with adaptive timestamps.
- `receipt.json`: source/tool/model hashes, explicit pins/states/references, construction, executed commands and approximation limits.

The source board, hashes and “pre-solved” assessment are in `source-provenance.json`. That term means a saved published routing checkpoint. The original AM3352 board has incomplete routing and failed strict DDR length checks; no independent measured SI or silicon validation was found. Its selected DQ0 and DQS routes exist and are extracted; simulation does not make the whole board fabrication-ready.

Vendor sources are official TI/Winbond downloads, pinned in `vendor-models.json`, `examples/vendor-models.lock.json` and `packages/ibis-to-spice/vendor-fixtures/models.lock.json`. Model files retain manufacturer notices and are downloaded locally rather than redistributed as repository source.

## Modeling limits

These are finite transient eyes, not BER extrapolation, jitter analysis, eye-mask certification or protocol compliance. The [DDR DQ0 example](examples/ddr-dq/index.circuit.tsx) is a continuous write-direction pad/channel experiment with a fixed eye timing origin. It omits DDR commands, bursts, training, memory/controller logic and clock recovery; selected I/O/ODT settings are explicit test assumptions. DQ0, DQS and DQSn use assumed uniform 0.75 mm center spacing. The single-ended fixture controls the CMOS output pad directly: its IBIS file has no Polarity keyword, so it does not invent an inverter logic-core relation or propagation delay.

Outside each supplied IBIS I/V table's voltage range, the converter holds the endpoint current. This is an explicit modeling approximation, recorded as `tableExtrapolation="hold-endpoint-current"`; it prevents SPICE's linear extension from inventing a false high-voltage operating point. Verification examines the complete raw waveform, including startup before the eye gate. The unterminated single-ended receiver rings above its 3.3 V supply (about 5.63 V in this fixture). Its selected input model has no power-clamp table, and these excursions require endpoint extrapolation beyond its characterized input range. The plots retain those excursions; this example does not establish a safe or compliant interface.

The original reduced backend supports one to three selected channels. It straightens route lengths/widths into stages with assumed signal spacing, a finite return strip, homogeneous effective dielectric properties and fixed-frequency R/L. Bends, complete planes, surrounding nets and full via pads/stubs are omitted in that mode. The routed backend instead retains selected physical copper and supports up to 32 signals; its distinct approximations are described above. Both modes use unswept transients and explicit ideal IBIS supplies, and omit dielectric loss, copper roughness, board PDN impedance and unselected electronics.

All examples explicitly use `packagePolicy="omit"`: the vendor files contain coupled or reference-rail package impedance that this backend cannot preserve. Real vendor buffer tables remain active. `packagePolicy="vendor"` rejects unsupported package cases instead of silently simplifying them. Receipts list omitted package values and warnings.

## Source and dependency rebuilds

The converter and pipeline source and tests are in this repository. `.packages/native-patches/manifest.json` pins official core/props/Circuit JSON bases and source patches. `.packages/browser-runtime/` contains the official browser/eval source lock and build patch. Included tarballs keep ordinary installation and preview reproducible; these changes are experimental and are not claimed to be merged upstream.

```sh
python3 scripts/rebuild-native-packages.py
python3 .packages/browser-runtime/rebuild.py
```

Original board attribution/license status is preserved. The workspace packages' MIT licenses do not relicense the board or manufacturer models.
