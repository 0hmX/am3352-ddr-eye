import { analog } from "@tscircuit/core"
import { ImportedBoard } from "pcb-spice-pipeline/tsx"
import routedBoard from "./am3352.circuit.json"
import { driver, receiver } from "./simulation.config"

export { modeling } from "./simulation.config"

export default function Board() {
  return (
    <ImportedBoard circuitJson={routedBoard}>
      <ibismodel componentRef="chip.U1" {...driver} />
      <ibismodel componentRef="chip.U3" {...receiver} />
      <analog.transientsimulation
        name="DDR_SI"
        duration="100ns"
        timePerStep="10ps"
        spiceEngine="pcb_spice"
        ibisPinStates={{
          ".U1 > .P1": { isOutput: true, isOutputEnabled: true },
          ".U1 > .P2": { isOutput: true, isOutputEnabled: true },
          ".U3 > .F3": { isOutput: false },
          ".U3 > .G3": { isOutput: false },
        }}
      />
      <analog.digitalstimulus name="DQS_P" simulationRef=".DDR_SI"
        sourcePinRef=".U1 > .P1" bitDuration="2.5ns" startTime="0ns"
        initialState={0} transmittedData={{ transmissionType: "bits", bits: "01", repeat: true }} />
      <analog.digitalstimulus name="DQS_N" simulationRef=".DDR_SI"
        sourcePinRef=".U1 > .P2" bitDuration="2.5ns" startTime="0ns"
        initialState={0} inverted transmittedData={{ transmissionType: "bits", bits: "01", repeat: true }} />
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
    </ImportedBoard>
  )
}
