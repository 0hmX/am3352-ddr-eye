This is a designed, manually routed RS-485 test board using the real TI SN65HVD72D IBIS model. It is a new simulation fixture, not a vendor reference board or a manufactured/validated PCB.

From the project root:

```sh
node examples/differential-data/verify-vendors.mjs
pnpm exec tsc --noEmit -p examples/differential-data/tsconfig.json
pnpm exec tsci build examples/differential-data/index.circuit.tsx --disable-parts-engine
pnpm exec pcb-spice-pipeline examples/differential-data/index.circuit.tsx --out .tscircuit/rs485-eye
pnpm exec pcb-spice-pipeline --repeat examples/differential-data/index.circuit.tsx --out .tscircuit/rs485-repeat
node examples/differential-data/verify-board.mjs .tscircuit/rs485-eye/inputs/circuit.json rs485
```

TI's [product page](https://www.ti.com/product/SN65HVD72) supplies the [SLLM183 IBIS archive](https://www.ti.com/lit/zip/sllm183). Archive/member hashes and pin/model expectations are in `../vendor-models.lock.json`; vendor files are downloaded locally and retain TI's license. Pins 6/7 are A/B, pin 8 is VCC and pin 5 is GND. The source uses the real `a_b_p`/`a_b_n` I/O tables, with explicit transmitter output state and receiver input state. The 4 us unit interval respects the [datasheet's 250 kbps rating](https://www.ti.com/lit/ds/symlink/sn65hvd72.pdf). Both legs receive the same declared bit sequence; B is inverted exactly once by its stimulus.

RTERM is a routed 120-ohm receiver termination; SPICE attaches it ideally at RX and omits its short stub-route parasitics. Power comes from the declared 3.3-V bench source at PWR. Two-layer construction, copper thickness, ground route, dielectric assumption and reduced solver geometry are explicit. The solver straightens routed bends and uses a finite bottom return strip; it omits ground-route bends/vias, nearby copper, loss and complete package/PDN behavior. The same transient run produces the differential A-minus-B eye and the A-to-ground leg eye under explicit data. It does not model receiver logic, turnaround or full RS-485 compliance.

Package parasitics are explicitly omitted for both chips: the files declare nonzero supply-pin package impedance that this backend cannot preserve. Real vendor I/V, clamp, die-capacitance and switching tables remain in use; the emitted provenance records package exclusion.

Unselected functional/control pins are outside this pad/channel fixture. The PCB routes selected signals, supply/reference rails and the stated termination; it is not a complete functional product circuit.
