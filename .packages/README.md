These local experimental dependencies are selected by the ordinary project's pnpm overrides. They are not published or claimed to be merged upstream.

- `tscircuit-core-ibis-experimental.tgz` and `tscircuit-props-ibis-experimental.tgz`: reusable model definitions, explicit experiment/stimulus state and probe-based eye declarations. Imported boards retain saved physical geometry.
- `circuit-json-general-experimental.tgz`: registered model, state, digital stimulus and eye records, plus probe-bound transient results.
- `tscircuit-experimental.tgz`: official browser/eval runtime rebuilt with those dependencies. Node exports and the standard CLI remain available. Rendering serializes the declarations; the local pipeline runs the electrical workflow.
- `ibis-to-spice-0.0.2.tgz`: browser build input from `../packages/ibis-to-spice`. Node uses that workspace package directly.
- `fanout-solver-experimental.tgz`: published 0.0.78 runtime with generated declarations for strict typechecking. Runtime source bytes are unchanged.

The source converter and pipeline are part of this repository, including tests and solver setup. `manifest.json` records archive hashes. `native-patches/manifest.json` records upstream bases and patches. `browser-runtime/` records official downloads, the dependency lock and worker build. Rebuild commands are in the root README. Manufacturer archives are downloaded on demand and hash checked; vendor notices are retained locally.
