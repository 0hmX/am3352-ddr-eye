This is a designed, manually routed single-ended CMOS pad/channel test using the real TI SN74LVC1G04 model. It is a simulation fixture, not a manufactured/validated PCB.

From the project root:

```sh
node examples/differential-data/verify-vendors.mjs
pnpm exec tsc --noEmit -p examples/single-ended/tsconfig.json
pnpm exec tsci build examples/single-ended/index.circuit.tsx --disable-parts-engine
pnpm exec pcb-spice-pipeline examples/single-ended/index.circuit.tsx --out .tscircuit/cmos-eye
pnpm exec pcb-spice-pipeline --repeat examples/single-ended/index.circuit.tsx --out .tscircuit/cmos-repeat
node examples/differential-data/verify-board.mjs .tscircuit/cmos-eye/inputs/circuit.json cmos
```

TI's [product page](https://www.ti.com/product/SN74LVC1G04) supplies the [SCEM216C IBIS archive](https://www.ti.com/lit/zip/scem216c). Hashes and expected physical pins are in `../vendor-models.lock.json`. The file forbids unauthorized redistribution, so the example fetches it locally. Component `LVC1G04_DCK` maps TX pin 4/Y using `LVC1G04_OUT_33` to RX pin 2/A using `LVC1G04_IN_33`. Pin 5 is VCC; pin 3 is GND. The explicit 3.3-V source powers both devices.

The source's output model has no Polarity keyword. The declared bits directly control output-buffer state; this example does not invent an A-to-Y inverter-core model or propagation delay. Vendor fixture tails extend to 23.6 ns; the 50 ns UI preserves them without overlapping adjacent transitions. It includes repeated bits and both transition directions. Two probes/eyes share one transient run: RX A relative to RX GND and TX Y relative to TX GND. Construction and the finite bottom return-strip approximation are explicit; ground bends/vias, surrounding copper, losses and receiver logic are omitted.

Package parasitics are explicitly omitted for both chips: the files declare nonzero supply-pin package impedance that this backend cannot preserve. Real vendor I/V, clamp, die-capacitance and switching tables remain in use; the emitted provenance records package exclusion.

Unselected functional/control pins are outside this pad/channel fixture. The PCB routes the selected signal and supply/reference rails; it is not a complete functional product circuit.
