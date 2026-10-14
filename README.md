# AM3352 DDR eye — tscircuit project

This is a normal tscircuit board project. `index.circuit.tsx` is the entrypoint; `tsci dev` provides the ordinary preview and `tsci build` produces Circuit JSON. Experimental IBIS and `<eyediagram>` support comes from pinned local dependency tarballs in `.packages/`, selected through `pnpm-workspace.yaml`. There is no project-specific renderer, server, solver implementation, or LLM at runtime.

The entry imports the exact published **astra/am3352-sbc v0.1.19** board snapshot, attaches TI and Winbond IBIS models to its actual U1/U3 chips, and declares one differential DQS eye. Saved routing is retained. This is the existing board imported through tscircuit's `circuitJson` prop; it does not reconstruct or reroute the historical board source.

Use Node.js 22 or later, pnpm 11.25.0, and Bun (required by this pinned tscircuit package's standard `tsci` launcher):

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm dev
```

For the standard Circuit JSON build:

```sh
pnpm build
```

The preview disables the parts engine in `tscircuit.config.json`; the build uses the standard CLI's `--disable-parts-engine` flag. This imported snapshot already contains its parts and footprints. This avoids unrelated supplier metadata lookups. Existing design warnings can still be reported; building the snapshot does not establish fabrication readiness.

For the local electrical workflow, install Python **3.11**, Git, and a C/C++ compiler. macOS also needs Homebrew and Xcode command-line tools. Setup installs native build dependencies through Homebrew on macOS or apt on Linux, builds pinned FastHenry, FasterCap and ngspice, and installs the pinned plotting environment under `node_modules/.cache/pcb-spice-pipeline`:

```sh
pnpm simulate:setup
pnpm simulate
pnpm simulate:repeat
```

The simulator is the reusable `pcb-spice-pipeline` dependency. Each invocation writes a fresh directory under `dist/`. The repeat command launches two separate processes, executes native solvers again, and compares extraction matrices, SPICE netlists, waveforms and plots. Source/model downloads are hash checked; solver results are not reused. Setup has been executed on macOS arm64; Linux support is supplied but is not validated by this local proof.

Outputs include `eye.png`, `eye.svg`, `waveform.png`, `waveform.csv`, `eye-data.csv`, the assembled SPICE decks, solver logs and `receipt.json`. A repeat run also writes `repeatability.json`. Receipt files record the executed tools, project/dependency hashes, original board hash, actual pin mappings, model selections and approximation limits.

Edit these ordinary project files:

- `index.circuit.tsx`: board entry and `<eyediagram>` probe/timing declaration.
- `simulation.config.ts`: typed vendor `IbisModelProps` declarations and modeling configuration export.
- `simulation.json`: locked vendor URLs/hashes, channel selection and explicit extraction assumptions.
- `board-construction.json`: copper dimensions and documented construction assumptions.
- `source-provenance.json`: original board release, supplier mappings and saved routing assessment.

The selected driver pins are U1 P1/P2 (TI AM3352); receiver pins are U3 F3/G3 (Winbond W631GG6MB-12). The demonstration uses TI Model_655/847, Winbond ODT_60 and the typical corner. Firmware settings are unknown. Vendor archives are downloaded from the manufacturers and verified against the committed hashes.

“Pre-solved” means a published saved routing checkpoint. The original board has incomplete routing and failed strict DDR length checks; no independently measured SI, manufactured construction, or silicon validation was found. The two selected DQS routes exist and are extracted.

The eye is a **deterministic clock demonstration**, not DDR data BER or JEDEC compliance. The channel uses actual saved route lengths/widths with straightened stages, assumed constant pair spacing, a finite return bar, homogeneous effective dielectric constants and fixed R/L at 100 MHz. Actual planes, bends, surrounding nets, dielectric loss, copper roughness, via pads/stubs, power-distribution impedance and TI's coupled package are omitted. Winbond pin RLC is included. See the construction file and generated receipts for exact numbers.

The reusable implementation and original proof/source evidence are delivered separately in `ddr-eye-example`; the converter is delivered separately in `ibis-to-spice`. Those repositories are not required to run this project: its dependency tarballs are included. Original board and manufacturer notices are preserved; the original board source is not represented as newly MIT licensed.
