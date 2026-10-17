# tscircuit IBIS / SPICE examples

One normal tscircuit project, with a TSX entrypoint, the standard `tsci dev` preview and `tsci build` output. The reusable converter and PCB simulation CLI live in `packages/`; experimental tscircuit dependencies and their source patches live in `.packages/`. There is no CI or LLM in the runtime workflow.

| Example | Board and real vendor models | Signal and stimulus |
| --- | --- | --- |
| `index.circuit.tsx` | Published **astra/am3352-sbc v0.1.19** routing; TI AM335x + Winbond W631GG6MB-12 | DDR DQS differential clock, 2.5 ns UI |
| [`examples/ddr-dq/index.circuit.tsx`](examples/ddr-dq/index.circuit.tsx) | Same routed AM3352 board and vendor sources | DQ0 victim with quiet/switching DQS neighbors, 2.5 ns UI |
| `examples/differential-data/index.circuit.tsx` | Designed routed fixture; TI SN65HVD72D | RS-485 differential arbitrary data, 4 us UI; differential and A-to-ground eyes |
| `examples/single-ended/index.circuit.tsx` | Designed routed fixture; TI SN74LVC1G04_DCK | Single-ended CMOS output-pad data, 50 ns UI; TX and RX eyes |

All examples use the same API, converter, extraction and native solver pipeline. The DDR DQ0 example declares two controlled transient experiments; each case has two eyes sharing its waveform. Other examples share one transient between their declared eyes. The two new fixtures contain real footprints, native manually routed traces, explicit voltage sources and board construction. They are pad/channel experiments, not complete functional products or independently validated boards.

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

For simulation, also install Python **3.11**, Git and a C/C++ compiler. macOS needs Homebrew and Xcode command-line tools. Setup builds unmodified pinned FastHenry, FasterCap and ngspice sources and installs the pinned plotting environment. It builds pinned wxWidgets 3.0 for upstream FasterCap; macOS uses Homebrew LLVM and libomp. Source trees, executables, installed libraries and startup configuration are checked against the build receipt. ngspice ignores local/user startup files; runtime path overrides must be unset. Earlier runtimes built with solver patches are rejected; rerun setup in a fresh cache if it reports modified sources. Setup installs native dependencies through Homebrew on macOS or apt on Linux; this delivery was executed on macOS arm64.

```sh
pnpm simulate:setup
pnpm simulate
pnpm simulate:ddr-dq
pnpm simulate:non-ddr
pnpm simulate:single-ended
```

Each native job has a 15-minute wall-clock limit. Set `PCB_SPICE_TIMEOUT_MS` to a positive integer to override it on slower machines; every command receipt records the applied limit.

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

The [DDR DQ0 example](examples/ddr-dq/index.circuit.tsx) compares a switching victim with two selected neighbors. `DDR_QUIET` holds DQS/DQSn at complementary constant levels; `DDR_SWITCHING` toggles them. Both cases retain identical victim traffic, IBIS states/models, rails, probes, geometry and coupled R/L/C matrices. Each runs one fresh ngspice transient.

```sh
pnpm simulate:ddr-dq --out dist/ddr-multisignal
pnpm simulate:compare dist/ddr-multisignal --probe DQ0_RX --out dist/ddr-comparison
```

The first command writes waveforms and declared eyes under `experiments/<id>/`. The comparison currently supports a ground-referenced, single-ended victim probe. It writes `comparison.json`, `waveform-comparison.png` and `eye-comparison.png`. It verifies saved artifact hashes and matching electrical conditions, and rejects a changed victim, model, reference, network or timing. Voltage differences use both adaptive time axes with linear interpolation; RMS is integrated over the declared eye observation gate. These are deterministic case differences within the modeled network.

DQ0 uses U1.M3 → U3.E3, TI `Model_343` and Winbond `ODT_60`; DQS/DQSn use U1.P1/P2 → U3.F3/G3 with TI `Model_655/847`. Hash-locked official vendor sources remain active. DQ0 repeats `00010111` at a 2.5 ns UI, covering every three-bit history; switching neighbors alternate with a 1.25 ns offset. All selected signals are solved together, preserving mutual R/L/C and the shared return. Uniform 0.75 mm center spacing is an explicit equivalent-channel assumption; the board's varying spacing and bends are not extracted.

The shared library rejects unsupported fan-out, ambiguous or duplicate physical lane selections, incomplete solver matrices, and failed physical/convergence checks. Generated plots and solver receipts stay local and are not checked in.

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

The workflow renders ordinary TSX to registered Circuit JSON declarations, extracts selected saved PCB routes, runs FastHenry for coupled R/L and FasterCap for C, assembles real vendor I/V/clamp/die-capacitance/switching tables with explicit sources and passives, executes one native ngspice transient per experiment, then folds every declared eye from its referenced probe.

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

The backend currently supports one to three selected channels and unswept transient simulations. It straightens the actual route lengths/widths into stages with assumed signal spacing, a finite return strip, homogeneous effective dielectric properties and fixed-frequency R/L. Bends, complete planes, surrounding nets, dielectric loss, copper roughness, full via pads/stubs and the board PDN are omitted. Explicit ideal supply sources power the selected IBIS reference nodes. Unselected electronics and functional/control pins are outside these experiments.

All examples explicitly use `packagePolicy="omit"`: the vendor files contain coupled or reference-rail package impedance that this backend cannot preserve. Real vendor buffer tables remain active. `packagePolicy="vendor"` rejects unsupported package cases instead of silently simplifying them. Receipts list omitted package values and warnings.

## Source and dependency rebuilds

The converter and pipeline source and tests are in this repository. `.packages/native-patches/manifest.json` pins official core/props/Circuit JSON bases and source patches. `.packages/browser-runtime/` contains the official browser/eval source lock and build patch. Included tarballs keep ordinary installation and preview reproducible; these changes are experimental and are not claimed to be merged upstream.

```sh
python3 scripts/rebuild-native-packages.py
python3 .packages/browser-runtime/rebuild.py
```

Original board attribution/license status is preserved. The workspace packages' MIT licenses do not relicense the board or manufacturer models.
