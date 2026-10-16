import type { IbisModelDefinition } from "@tscircuit/props"
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
