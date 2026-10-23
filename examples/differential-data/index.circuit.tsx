import { analog } from "@tscircuit/core"
import { rs485Pads } from "./models"
import { BenchSupply, RoutedTrace, Soic8Pads } from "./pcb"
import type { PcbSpiceChannelProps } from "@tscircuit/props"


// Designed board; the bus traces keep their total length/width but are
// straightened into parallel strips at 6 mm center spacing over a finite
// 0.35 mm bottom return strip (y=-6 mm, 1.5292 mm separation). Homogeneous
// εr=4.1; air fields, dielectric loss and package coupling are omitted. RTERM is
// the real routed 120-ohm resistor, included in the simulated scope.
const channel: PcbSpiceChannelProps = {
  reduction: "straightened-stages",
  sections: 12,
  lanes: [
    { name: "A", from: ".TX > .A", to: ".RX > .A" },
    { name: "B", from: ".TX > .B", to: ".RX > .B" },
  ],
  referencePinRef: ".TX > .GND",
  passiveComponentRefs: [".RTERM"],
  extraction: {
    minimumFrequency: "1Hz", maximumFrequency: "100MHz", modelFrequency: "1MHz",
    filaments: 7, refinementFilaments: 11, convergenceTolerance: 0.05,
    capacitanceTolerance: 0.02, maxPanelLength: "2mm", reciprocityTolerance: 0.025,
    dcResistanceTolerance: 0.002,
  },
  straightenedStageProfiles: { top: {
    spacing: "6mm", relativePermittivity: 4.1,
    return: { width: "0.35mm", thickness: "0.035mm", lengthFactor: 1, centerY: "-6mm", centerZ: "-1.5292mm" },
  } },
}

const pins = { pin1: "R", pin2: "RE_N", pin3: "DE", pin4: "D", pin5: "GND", pin6: "A", pin7: "B", pin8: "VCC" }
const bits = "0011101001010110"

/** Designed routed RS-485 pad/channel experiment; no receiver/core logic model. */
export default function Board() {
  return <board width={52} height={22} thickness={1.6} layers={4} fabricatorPreset="jlcpcb_standard" routingDisabled schematicDisabled>
    <chip name="TX" manufacturerPartNumber="SN65HVD72D" pcbX={-15} pcbY={0}
      pinLabels={pins} footprint={<Soic8Pads />}  />
    <chip name="RX" manufacturerPartNumber="SN65HVD72D" pcbX={15} pcbY={0}
      pinLabels={pins} footprint={<Soic8Pads />}  />
    <ibismodel componentRef=".TX" {...rs485Pads} />
    <ibismodel componentRef=".RX" {...rs485Pads} />
    <BenchSupply />
    <resistor name="RTERM" resistance="120" pcbX={22} pcbY={0} pcbRotation={90} footprint="0603" />
    <RoutedTrace name="BUS_A" from=".TX > .A" to=".RX > .A" origin={[-15, 0]}
      points={[{ x: -10, y: -0.635 }, { x: -10, y: -3 }, { x: 20, y: -3 }, { x: 20, y: -0.635 }]} />
    <RoutedTrace name="BUS_B" from=".TX > .B" to=".RX > .B" origin={[-15, 0]}
      points={[{ x: -10, y: 0.635 }, { x: -10, y: 3 }, { x: 20, y: 3 }, { x: 20, y: 0.635 }]} />
    <trace from=".RX > .A" to=".RTERM > .pin1" thickness={0.25} pcbPath={[".RX > .A", ".RTERM > .pin1"]} />
    <trace from=".RX > .B" to=".RTERM > .pin2" thickness={0.25} pcbPath={[".RX > .B", ".RTERM > .pin2"]} />
    <RoutedTrace from=".PWR > .VCC" to=".TX > .VCC" origin={[-22, 7]} width={0.35}
      points={[{ x: -23, y: 6, via: true, fromLayer: "top", toLayer: "bottom" }, { x: -11, y: 6 }, { x: -11, y: 1.905, via: true, fromLayer: "bottom", toLayer: "top" }]} />
    <RoutedTrace from=".TX > .VCC" to=".RX > .VCC" origin={[-15, 0]} width={0.35}
      points={[{ x: -11, y: 1.905, via: true, fromLayer: "top", toLayer: "bottom" }, { x: -11, y: 6 }, { x: 19, y: 6 }, { x: 19, y: 1.905, via: true, fromLayer: "bottom", toLayer: "top" }]} />
    <RoutedTrace from=".PWR > .GND" to=".TX > .GND" origin={[-22, 7]} width={0.35}
      points={[{ x: -21, y: 5, via: true, fromLayer: "top", toLayer: "bottom" }, { x: -13, y: 5 }, { x: -13, y: -1.905, via: true, fromLayer: "bottom", toLayer: "top" }]} />
    <RoutedTrace name="GROUND_RETURN" from=".TX > .GND" to=".RX > .GND" origin={[-15, 0]} width={0.35}
      points={[{ x: -13, y: -1.905, via: true, fromLayer: "top", toLayer: "bottom" }, { x: -13, y: -6 }, { x: 19, y: -6 }, { x: 19, y: -1.905, via: true, fromLayer: "bottom", toLayer: "top" }]} />
    <analog.transientsimulation spiceEngine="pcb_spice" name="SI" duration="128us" timePerStep="5ns" ibisPinStates={{
      ".TX > .A": { isOutput: true, isOutputEnabled: true }, ".TX > .B": { isOutput: true, isOutputEnabled: true },
      ".RX > .A": { isOutput: false }, ".RX > .B": { isOutput: false },
    }} pcbSpiceChannel={channel} />
    <analog.digitalstimulus name="DATA_A" simulationRef=".SI" sourcePinRef=".TX > .A"
      bitDuration="4us" startTime="0us" initialState={0} transmittedData={{ transmissionType: "bits", bits, repeat: true }} />
    <analog.digitalstimulus name="DATA_B" simulationRef=".SI" sourcePinRef=".TX > .B"
      bitDuration="4us" startTime="0us" initialState={0} inverted transmittedData={{ transmissionType: "bits", bits, repeat: true }} />
    <voltageprobe name="BUS_RX" connectsTo=".RX > .A" referenceTo=".RX > .B" />
    <analog.eyediagram name="RS485_DATA" simulationRef=".SI" probeRef=".BUS_RX"
      unitInterval="4us" timeOrigin="0us" startTime="16us" endTime="128us" />
    <voltageprobe name="BUS_A_GROUND" connectsTo=".RX > .A" referenceTo=".RX > .GND" />
    <analog.eyediagram name="RS485_A_TO_GROUND" simulationRef=".SI" probeRef=".BUS_A_GROUND"
      unitInterval="4us" timeOrigin="0us" startTime="16us" endTime="128us" />
    <pcbnotetext pcbY={9} text="DESIGNED RS-485 PAD/CHANNEL TEST" fontSize={0.8} />
  </board>
}
