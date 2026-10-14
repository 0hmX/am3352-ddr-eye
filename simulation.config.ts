import type { IbisModelDefinition } from "@tscircuit/props"
import settings from "./simulation.json"
import boardConstruction from "./board-construction.json"
import sourceProvenance from "./source-provenance.json"
import vendorModels from "./vendor-models.json"

const [ti, winbond] = vendorModels

export const driver: IbisModelDefinition = {
  source: {
    url: ti.url, sha256: ti.sha256,
    archive: { member: ti.archivePath, sha256: ti.archiveSha256 },
  },
  component: "am335x_zcz",
  pinMap: { P1: "P1", P2: "P2", E5: "E5", A1: "A1" },
  modelSelections: { P1: "Model_655", P2: "Model_847" },
  references: {
    P1: { pullup: "E5", pulldown: "A1", powerClamp: "E5", groundClamp: "A1" },
    P2: { pullup: "E5", pulldown: "A1", powerClamp: "E5", groundClamp: "A1" },
  },
  corner: "typical",
  packagePolicy: "omit",
}

export const receiver: IbisModelDefinition = {
  source: {
    url: winbond.url, sha256: winbond.sha256,
    archive: { member: winbond.archivePath, sha256: winbond.archiveSha256 },
  },
  component: "W631GG6MB-12",
  pinMap: { F3: "F3", G3: "G3", A1: "A1", B1: "B1" },
  modelSelections: { F3: "ODT_60", G3: "ODT_60" },
  references: {
    F3: { pullup: "A1", pulldown: "B1", powerClamp: "A1", groundClamp: "B1" },
    G3: { pullup: "A1", pulldown: "B1", powerClamp: "A1", groundClamp: "B1" },
  },
  corner: "typical",
  packagePolicy: "omit",
}

export const modeling = {
  ...settings,
  stackup: boardConstruction.copperLayers,
  channelReference: { component: "U1", port: "A1" },
  boardConstruction,
  sourceProvenance,
}
