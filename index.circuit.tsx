import type { BoardProps } from "@tscircuit/props"
import { analog } from "@tscircuit/core"
import routedBoard from "./am3352.circuit.json"
import { driver, receiver } from "./simulation.config"

export { modeling } from "./simulation.config"

export default function Board() {
  return (
    <board
      circuitJson={routedBoard as NonNullable<BoardProps["circuitJson"]>}
      routingDisabled
      schematicDisabled
    >
      <ibismodel componentRef=".U1" {...driver} />
      <ibismodel componentRef=".U3" {...receiver} />
      <voltagesource name="V1" doNotPlace voltage="1.5V"
        connections={{ pos: ".U1 > .E5", neg: ".U1 > .A1" }} />
      <analog.transientsimulation
        name="DDR_SI"
        duration="100ns"
        timePerStep="10ps"
        spiceEngine="ngspice"
        ibisPinStates={{
          ".U1 > .P1": { mode: "output", enabled: true },
          ".U1 > .P2": { mode: "output", enabled: true },
          ".U3 > .F3": { mode: "input" },
          ".U3 > .G3": { mode: "input" },
        }}
      />
      <analog.digitalstimulus name="DQS_P" simulationRef=".DDR_SI"
        drives=".U1 > .P1" unitInterval="2.5ns" startTime="0ns"
        initialState={0} pattern={{ type: "bits", bits: "01", repeat: true }} />
      <analog.digitalstimulus name="DQS_N" simulationRef=".DDR_SI"
        drives=".U1 > .P2" unitInterval="2.5ns" startTime="0ns"
        initialState={0} inverted pattern={{ type: "bits", bits: "01", repeat: true }} />
      <voltageprobe name="DDR_RX" connectsTo=".U3 > .F3" referenceTo=".U3 > .G3" />
      <voltageprobe name="DDR_TX" connectsTo=".U1 > .P1" referenceTo=".U1 > .P2" />
      <analog.eyediagram
        name="DDR_receive_eye"
        simulationRef=".DDR_SI"
        probeRef=".DDR_RX"
        unitInterval="2.5ns"
        timeOrigin="0ns"
        startTime="20ns"
      />
      <analog.eyediagram
        name="DDR_transmit_eye"
        simulationRef=".DDR_SI"
        probeRef=".DDR_TX"
        unitInterval="2.5ns"
        timeOrigin="0ns"
        startTime="20ns"
      />
    </board>
  )
}
