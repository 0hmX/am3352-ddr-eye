import type { IbisModelDefinition } from "@tscircuit/ibis-to-spice"
import { si } from "pcb-spice-pipeline/tsx"
import routedBoard from "../../am3352.circuit.json"
import {
  driver as dqsDriver,
  receiver as dqsReceiver,
  modeling as dqsModeling,
} from "../../simulation.config"

const driver: IbisModelDefinition = {
  ...dqsDriver,
  pinMap: { ...dqsDriver.pinMap, M3: "M3" },
  modelSelections: { ...dqsDriver.modelSelections, M3: "Model_343" },
  references: {
    ...dqsDriver.references,
    M3: { pullup: "E5", pulldown: "A1", powerClamp: "E5", groundClamp: "A1" },
  },
}

const receiver: IbisModelDefinition = {
  ...dqsReceiver,
  pinMap: { ...dqsReceiver.pinMap, E3: "E3" },
  modelSelections: { ...dqsReceiver.modelSelections, E3: "ODT_60" },
  references: {
    ...dqsReceiver.references,
    E3: { pullup: "A1", pulldown: "B1", powerClamp: "A1", groundClamp: "B1" },
  },
}

export const modeling = {
  ...dqsModeling,
  circuit: "../../am3352.circuit.json",
  description: "AM3352 DQ0 victim with quiet and switching DQS/DQSn neighbors in a coupled equivalent channel",
  lanes: [
    {
      port: "DQ0", driverPort: "M3", receiverPort: "E3",
      from: { component: "U1", port: "M3" },
      to: { component: "U3", port: "E3" },
    },
    ...dqsModeling.lanes,
  ],
  boardConstruction: {
    ...dqsModeling.boardConstruction,
    extractionAssumptions: {
      ...dqsModeling.boardConstruction.extractionAssumptions,
      separationStatus: "Ordered DQ0, DQS, DQSn at uniform 0.75mm center spacing; equivalent-channel assumption, not the real varying spacing. Original routed coordinates remain preserved.",
      omissions: dqsModeling.boardConstruction.extractionAssumptions.omissions.map(
        (item) => item.replace("neighboring-net coupling", "unselected neighboring-net coupling"),
      ),
    },
  },
}

export default function Board() {
  return (
    <>
    <si.ImportedBoard circuitJson={routedBoard} />
      <si.Model componentRef=".U1" {...driver} />
      <si.Model componentRef=".U3" {...receiver} />
      <si.Probe name="DDR_RX" connectsTo=".U3 > .F3" referenceTo=".U3 > .G3" />
      <si.Probe name="DDR_TX" connectsTo=".U1 > .P1" referenceTo=".U1 > .P2" />
      <si.Probe name="DQ0_RX" connectsTo=".U3 > .E3" referenceTo=".U3 > .B1" />
      <si.Probe name="DQ0_TX" connectsTo=".U1 > .M3" referenceTo=".U1 > .A1" />
      <si.Probe name="DQS_RX" connectsTo=".U3 > .F3" referenceTo=".U3 > .B1" />
      <si.Probe name="DQSn_RX" connectsTo=".U3 > .G3" referenceTo=".U3 > .B1" />
      {/* Keep the coupled geometry, buffers, rails and victim identical in both runs. */}
      {(["QUIET", "SWITCHING"] as const).map((activity) => {
        const simulationRef = `.DDR_${activity}`
        const neighborBits = activity === "QUIET" ? "0" : "01"
        return [
          <si.Transient key={`simulation-${activity}`} name={`DDR_${activity}`} duration="160ns"
            timePerStep="10ps" spiceEngine="ngspice" ibisPinStates={{
              ".U1 > .M3": { mode: "output", enabled: true },
              ".U1 > .P1": { mode: "output", enabled: true },
              ".U1 > .P2": { mode: "output", enabled: true },
              ".U3 > .E3": { mode: "input" },
              ".U3 > .F3": { mode: "input" },
              ".U3 > .G3": { mode: "input" },
            }} />,
          // Repeating 00010111 covers all eight three-bit victim histories.
          <si.Stimulus key={`victim-${activity}`} name={`DQ0_${activity}`} simulationRef={simulationRef}
            drives=".U1 > .M3" unitInterval="2.5ns" startTime="0ns"
            initialState={0} pattern={{ type: "bits", bits: "00010111", repeat: true }} />,
          // Quiet neighbors remain driven low/high. Switching edges are DQ-centered.
          <si.Stimulus key={`dqs-${activity}`} name={`DQS_P_${activity}`} simulationRef={simulationRef}
            drives=".U1 > .P1" unitInterval="2.5ns" startTime="1.25ns"
            initialState={0} pattern={{ type: "bits", bits: neighborBits, repeat: true }} />,
          <si.Stimulus key={`dqsn-${activity}`} name={`DQS_N_${activity}`} simulationRef={simulationRef}
            drives=".U1 > .P2" unitInterval="2.5ns" startTime="1.25ns"
            initialState={0} inverted pattern={{ type: "bits", bits: neighborBits, repeat: true }} />,
          <si.Eye key={`victim-eye-${activity}`} name={`DQ0_receive_eye_${activity}`} simulationRef={simulationRef}
            probeRef=".DQ0_RX" unitInterval="2.5ns" timeOrigin="0ns" startTime="40ns" />,
          <si.Eye key={`strobe-eye-${activity}`} name={`DQS_receive_eye_${activity}`} simulationRef={simulationRef}
            probeRef=".DDR_RX" unitInterval="2.5ns" timeOrigin="1.25ns" startTime="40ns" />,
        ]
      })}
    </>
  )
}
