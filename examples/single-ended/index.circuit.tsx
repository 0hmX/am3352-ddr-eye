import { si } from "pcb-spice-pipeline/tsx"
import { inputPad, outputPad } from "./models"
import { BenchSupply, RoutedTrace, Sc70Pads } from "../differential-data/pcb"
import construction from "./board-construction.json"
export { modeling } from "./simulation.config"

const pins = { pin1: "NC", pin2: "A", pin3: "GND", pin4: "Y", pin5: "VCC" }

/** Explicit CMOS output-pad data; this does not simulate the inverter core. */
export default function Board() {
  return <board width={construction.widthMm} height={construction.heightMm}
    thickness={construction.thicknessMm} layers={2} routingDisabled schematicDisabled>
    <chip name="TX" manufacturerPartNumber="SN74LVC1G04DCK" pcbX={-15} pcbY={0}
      pinLabels={pins} footprint={<Sc70Pads />}  />
    <chip name="RX" manufacturerPartNumber="SN74LVC1G04DCK" pcbX={15} pcbY={0}
      pinLabels={pins} footprint={<Sc70Pads />}  />
    <si.Model componentRef=".TX" {...outputPad} />
    <si.Model componentRef=".RX" {...inputPad} />
    <BenchSupply />
    <RoutedTrace name="CMOS_DATA" from=".TX > .Y" to=".RX > .A" origin={[-15, 0]}
      points={[{ x: -12, y: -0.65 }, { x: -12, y: 0 }]} />
    <RoutedTrace from=".PWR > .VCC" to=".TX > .VCC" origin={[-22, 7]} width={0.35}
      points={[{ x: -23, y: 6, via: true, fromLayer: "top", toLayer: "bottom" }, { x: -13, y: 6 }, { x: -13, y: 0.65, via: true, fromLayer: "bottom", toLayer: "top" }]} />
    <RoutedTrace from=".TX > .VCC" to=".RX > .VCC" origin={[-15, 0]} width={0.35}
      points={[{ x: -13, y: 0.65, via: true, fromLayer: "top", toLayer: "bottom" }, { x: -13, y: 6 }, { x: 17, y: 6 }, { x: 17, y: 0.65, via: true, fromLayer: "bottom", toLayer: "top" }]} />
    <RoutedTrace from=".PWR > .GND" to=".TX > .GND" origin={[-22, 7]} width={0.35}
      points={[{ x: -21, y: 5, via: true, fromLayer: "top", toLayer: "bottom" }, { x: -17, y: 5 }, { x: -17, y: -0.65, via: true, fromLayer: "bottom", toLayer: "top" }]} />
    <RoutedTrace name="GROUND_RETURN" from=".TX > .GND" to=".RX > .GND" origin={[-15, 0]} width={0.35}
      points={[{ x: -17, y: -0.65, via: true, fromLayer: "top", toLayer: "bottom" }, { x: -17, y: -6 }, { x: 13, y: -6 }, { x: 13, y: -0.65, via: true, fromLayer: "bottom", toLayer: "top" }]} />
    <si.Transient name="SI" duration="1600ns" timePerStep="50ps" ibisPinStates={{
      ".TX > .Y": { mode: "output", enabled: true }, ".RX > .A": { mode: "input" },
    }} />
    <si.Stimulus name="DATA" simulationRef=".SI" drives=".TX > .Y"
      unitInterval="50ns" startTime="0ns" initialState={0}
      pattern={{ type: "bits", bits: "001110100101011000101101", repeat: true }} />
    <si.Probe name="DATA_RX" connectsTo=".RX > .A" referenceTo=".RX > .GND" />
    <si.Eye name="CMOS_DATA" simulationRef=".SI" probeRef=".DATA_RX"
      unitInterval="50ns" timeOrigin="0ns" startTime="200ns" endTime="1600ns" />
    <si.Probe name="DATA_TX" connectsTo=".TX > .Y" referenceTo=".TX > .GND" />
    <si.Eye name="CMOS_TX" simulationRef=".SI" probeRef=".DATA_TX"
      unitInterval="50ns" timeOrigin="0ns" startTime="200ns" endTime="1600ns" />
    <pcbnotetext pcbY={9} text="DESIGNED CMOS PAD/CHANNEL TEST" fontSize={0.8} />
  </board>
}
