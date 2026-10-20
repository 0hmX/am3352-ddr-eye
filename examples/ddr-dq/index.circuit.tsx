import type { IbisModelDefinition } from "@tscircuit/props"
import { analog } from "@tscircuit/core"
import { ImportedBoard } from "pcb-spice-pipeline/tsx"
import routedBoard from "../../am3352.circuit.json"
import {
  driver as dqsDriver,
  receiver as dqsReceiver,
  modeling as dqsModeling,
} from "../../simulation.config"

const driver: IbisModelDefinition = {
  ...dqsDriver,
  ibisPinNameToPortLabel: { ...dqsDriver.ibisPinNameToPortLabel, M3: "M3" },
  ibisPinNameToModelName: { ...dqsDriver.ibisPinNameToModelName, M3: "Model_343" },
  ibisPinNameToReferencePortLabels: {
    ...dqsDriver.ibisPinNameToReferencePortLabels,
    M3: { pullup: "E5", pulldown: "A1", powerClamp: "E5", groundClamp: "A1" },
  },
}

const receiver: IbisModelDefinition = {
  ...dqsReceiver,
  ibisPinNameToPortLabel: { ...dqsReceiver.ibisPinNameToPortLabel, E3: "E3" },
  ibisPinNameToModelName: { ...dqsReceiver.ibisPinNameToModelName, E3: "ODT_60" },
  ibisPinNameToReferencePortLabels: {
    ...dqsReceiver.ibisPinNameToReferencePortLabels,
    E3: { pullup: "A1", pulldown: "B1", powerClamp: "A1", groundClamp: "B1" },
  },
}

export const modeling = {
  ...dqsModeling,
  circuit: "../../am3352.circuit.json",
  description: "AM3352 DQ0 victim with quiet and switching DQS/DQSn neighbors; original routed traces and inferred GND copper",
  lanes: [
    {
      port: "DQ0", driverPort: "M3", receiverPort: "E3",
      from: { component: "U1", port: "M3" },
      to: { component: "U3", port: "E3" },
    },
    ...dqsModeling.lanes,
  ],
}

export default function Board() {
  return (
    <ImportedBoard circuitJson={routedBoard}>
      <ibismodel componentRef="chip.U1" {...driver} />
      <ibismodel componentRef="chip.U3" {...receiver} />
      <voltageprobe name="DDR_RX" connectsTo=".U3 > .F3" referenceTo=".U3 > .G3" />
      <voltageprobe name="DDR_TX" connectsTo=".U1 > .P1" referenceTo=".U1 > .P2" />
      <voltageprobe name="DQ0_RX" connectsTo=".U3 > .E3" referenceTo=".U3 > .B1" />
      <voltageprobe name="DQ0_TX" connectsTo=".U1 > .M3" referenceTo=".U1 > .A1" />
      <voltageprobe name="DQS_RX" connectsTo=".U3 > .F3" referenceTo=".U3 > .B1" />
      <voltageprobe name="DQSn_RX" connectsTo=".U3 > .G3" referenceTo=".U3 > .B1" />
      {/* Keep the routed geometry, buffers, rails and victim identical in both runs. */}
      {(["QUIET", "SWITCHING"] as const).map((activity) => {
        const simulationRef = `.DDR_${activity}`
        const neighborBits = { QUIET: "0", SWITCHING: "01" }[activity]
        return [
          <analog.transientsimulation key={`simulation-${activity}`} name={`DDR_${activity}`} duration="160ns"
            timePerStep="10ps" spiceEngine="pcb_spice" ibisPinStates={{
              ".U1 > .M3": { isOutput: true, isOutputEnabled: true },
              ".U1 > .P1": { isOutput: true, isOutputEnabled: true },
              ".U1 > .P2": { isOutput: true, isOutputEnabled: true },
              ".U3 > .E3": { isOutput: false },
              ".U3 > .F3": { isOutput: false },
              ".U3 > .G3": { isOutput: false },
            }} />,
          // Fixed 00010111 (not PRBS), 2.5 ns/bit = 400 MT/s; covers all eight three-bit histories.
          <analog.digitalstimulus key={`victim-${activity}`} name={`DQ0_${activity}`} simulationRef={simulationRef}
            drives=".U1 > .M3" unitInterval="2.5ns" startTime="0ns"
            initialState={0} pattern={{ type: "bits", bits: "00010111", repeat: true }} />,
          // Quiet neighbors remain driven low/high. Switching edges are DQ-centered.
          <analog.digitalstimulus key={`dqs-${activity}`} name={`DQS_P_${activity}`} simulationRef={simulationRef}
            drives=".U1 > .P1" unitInterval="2.5ns" startTime="1.25ns"
            initialState={0} pattern={{ type: "bits", bits: neighborBits, repeat: true }} />,
          <analog.digitalstimulus key={`dqsn-${activity}`} name={`DQS_N_${activity}`} simulationRef={simulationRef}
            drives=".U1 > .P2" unitInterval="2.5ns" startTime="1.25ns"
            initialState={0} inverted pattern={{ type: "bits", bits: neighborBits, repeat: true }} />,
          // Skip the first 16 UIs (40 ns); fold on the declared stimulus clock.
          <analog.eyediagram key={`victim-eye-${activity}`} name={`DQ0_receive_eye_${activity}`} simulationRef={simulationRef}
            probeRef=".DQ0_RX" unitInterval="2.5ns" timeOrigin="0ns" startTime="40ns" />,
          <analog.eyediagram key={`strobe-eye-${activity}`} name={`DQS_receive_eye_${activity}`} simulationRef={simulationRef}
            probeRef=".DDR_RX" unitInterval="2.5ns" timeOrigin="1.25ns" startTime="40ns" />,
        ]
      })}
    </ImportedBoard>
  )
}
