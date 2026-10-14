These are local experimental npm dependencies, selected through the normal project's pnpm-workspace.yaml overrides. They have not been published or merged upstream.

- tscircuit-core-ibis-experimental.tgz and tscircuit-props-ibis-experimental.tgz: native ibisModel/eyediagram and faithful imported-board support.
- tscircuit-experimental.tgz: official tscircuit browser/eval runtime rebuilt with those features; Node exports and standard CLI are retained. Browser vendor downloads use the existing local CLI proxy.
- fanout-solver-experimental.tgz: exact published 0.0.78 runtime sources, with real generated declaration files added for strict consumer type checking. Runtime source bytes are unchanged.
- ibis-to-spice-0.0.1.tgz: reusable table-based converter.
- pcb-spice-pipeline-0.1.0.tgz: reusable extraction, assembly, native solver execution and plotting CLI. Its implementation is included in the tarball; it is not a project-specific runner.

Package hashes and source/build provenance are recorded beside these archives. A future upstream release can replace these file dependencies without changing the project layout or board entrypoint. The real-board snapshot retains its original attribution and licensing status; vendor model notices are retained when the manufacturer's archives are downloaded.
