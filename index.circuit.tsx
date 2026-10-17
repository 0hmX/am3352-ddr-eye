import { si } from "pcb-spice-pipeline/tsx"
import routedBoard from "./am3352.circuit.json"
import { driver, receiver } from "./simulation.config"

export { modeling } from "./simulation.config"

export default function Board() {
  return (
    <>
    <si.ImportedBoard circuitJson={routedBoard} />
      <si.Model componentRef=".U1" {...driver} />
      <si.Model componentRef=".U3" {...receiver} />
      <si.Transient
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
      <si.Stimulus name="DQS_P" simulationRef=".DDR_SI"
        drives=".U1 > .P1" unitInterval="2.5ns" startTime="0ns"
        initialState={0} pattern={{ type: "bits", bits: "01", repeat: true }} />
      <si.Stimulus name="DQS_N" simulationRef=".DDR_SI"
        drives=".U1 > .P2" unitInterval="2.5ns" startTime="0ns"
        initialState={0} inverted pattern={{ type: "bits", bits: "01", repeat: true }} />
      <si.Probe name="DDR_RX" connectsTo=".U3 > .F3" referenceTo=".U3 > .G3" />
      <si.Probe name="DDR_TX" connectsTo=".U1 > .P1" referenceTo=".U1 > .P2" />
      <si.Eye
        name="DDR_receive_eye"
        simulationRef=".DDR_SI"
        probeRef=".DDR_RX"
        unitInterval="2.5ns"
        timeOrigin="0ns"
        startTime="20ns"
      />
      <si.Eye
        name="DDR_transmit_eye"
        simulationRef=".DDR_SI"
        probeRef=".DDR_TX"
        unitInterval="2.5ns"
        timeOrigin="0ns"
        startTime="20ns"
      />
    </>
  )
}
