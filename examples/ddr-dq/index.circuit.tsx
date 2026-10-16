import type { BoardProps, IbisModelDefinition } from "@tscircuit/props"
import { analog } from "@tscircuit/core"
import routedBoard from "../../am3352.circuit.json"
import {
  driver as dqsDriver,
  receiver as dqsReceiver,
  modeling as dqsModeling,
} from "../../simulation.config"

export const driver: IbisModelDefinition = {
  ...dqsDriver,
  pinMap: { ...dqsDriver.pinMap, M3: "M3" },
  modelSelections: { ...dqsDriver.modelSelections, M3: "Model_343" },
  references: {
    ...dqsDriver.references,
    M3: { pullup: "E5", pulldown: "A1", powerClamp: "E5", groundClamp: "A1" },
  },
}

export const receiver: IbisModelDefinition = {
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
  description: "AM3352 routed DQ0 data and DQS strobe; all eight three-bit histories",
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
    },
  },
}

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
        duration="160ns"
        timePerStep="10ps"
        spiceEngine="ngspice"
        ibisPinStates={{
          ".U1 > .M3": { mode: "output", enabled: true },
          ".U1 > .P1": { mode: "output", enabled: true },
          ".U1 > .P2": { mode: "output", enabled: true },
          ".U3 > .F3": { mode: "input" },
          ".U3 > .G3": { mode: "input" },
          ".U3 > .E3": { mode: "input" },
        }}
      />
      {/* Repeating 00010111 covers every three-bit history, including wraparound. */}
      <analog.digitalstimulus name="DQ0" simulationRef=".DDR_SI"
        drives=".U1 > .M3" unitInterval="2.5ns" startTime="0ns"
        initialState={0} pattern={{ type: "bits", bits: "00010111", repeat: true }} />
      {/* DQS edges are nominally centered in each DQ bit for this write-direction pad test. */}
      <analog.digitalstimulus name="DQS_P" simulationRef=".DDR_SI"
        drives=".U1 > .P1" unitInterval="2.5ns" startTime="1.25ns"
        initialState={0} pattern={{ type: "bits", bits: "01", repeat: true }} />
      <analog.digitalstimulus name="DQS_N" simulationRef=".DDR_SI"
        drives=".U1 > .P2" unitInterval="2.5ns" startTime="1.25ns"
        initialState={0} inverted pattern={{ type: "bits", bits: "01", repeat: true }} />
      <voltageprobe name="DDR_RX" connectsTo=".U3 > .F3" referenceTo=".U3 > .G3" />
      <voltageprobe name="DDR_TX" connectsTo=".U1 > .P1" referenceTo=".U1 > .P2" />
      <voltageprobe name="DQ0_RX" connectsTo=".U3 > .E3" referenceTo=".U3 > .B1" />
      <voltageprobe name="DQ0_TX" connectsTo=".U1 > .M3" referenceTo=".U1 > .A1" />
      <analog.eyediagram
        name="DQ0_receive_eye"
        simulationRef=".DDR_SI"
        probeRef=".DQ0_RX"
        unitInterval="2.5ns"
        timeOrigin="0ns"
        startTime="40ns"
      />
      <analog.eyediagram
        name="DQS_receive_eye"
        simulationRef=".DDR_SI"
        probeRef=".DDR_RX"
        unitInterval="2.5ns"
        timeOrigin="1.25ns"
        startTime="40ns"
      />
    </board>
  )
}
