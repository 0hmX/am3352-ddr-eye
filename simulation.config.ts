import type { IbisModelDefinition } from "@tscircuit/props"
import settings from "./simulation.json"
import boardConstruction from "./board-construction.json"
import sourceProvenance from "./source-provenance.json"
import vendorModels from "./vendor-models.json"

const [ti, winbond] = vendorModels

export const driver: IbisModelDefinition = {
  ibisModelAsset: {
    project_relative_path: `models/${ti.file}`,
    url: `./models/${ti.file}`,
    mimetype: "text/plain",
  },
  ibisComponentName: "am335x_zcz",
  ibisPinNameToPortLabel: { P1: "P1", P2: "P2", E5: "E5", A1: "A1" },
  ibisPinNameToModelName: { P1: "Model_655", P2: "Model_847" },
  ibisPinNameToReferencePortLabels: {
    P1: { pullup: "E5", pulldown: "A1", powerClamp: "E5", groundClamp: "A1" },
    P2: { pullup: "E5", pulldown: "A1", powerClamp: "E5", groundClamp: "A1" },
  },
  modelValueCorner: "typical",
  includePackageParasitics: false,
}

export const receiver: IbisModelDefinition = {
  ibisModelAsset: {
    project_relative_path: `models/${winbond.file}`,
    url: `./models/${winbond.file}`,
    mimetype: "text/plain",
  },
  ibisComponentName: "W631GG6MB-12",
  ibisPinNameToPortLabel: { F3: "F3", G3: "G3", A1: "A1", B1: "B1" },
  ibisPinNameToModelName: { F3: "ODT_60", G3: "ODT_60" },
  ibisPinNameToReferencePortLabels: {
    F3: { pullup: "A1", pulldown: "B1", powerClamp: "A1", groundClamp: "B1" },
    G3: { pullup: "A1", pulldown: "B1", powerClamp: "A1", groundClamp: "B1" },
  },
  modelValueCorner: "typical",
  includePackageParasitics: false,
}

export const modeling = {
  ...settings,
  ibisModelAssetSha256: Object.fromEntries(vendorModels.map(vendor => [`models/${vendor.file}`, vendor.sha256])),
  stackup: boardConstruction.copperLayers,
  supplies: [{ positive: { component: "U1", port: "E5" }, negative: { component: "U1", port: "A1" }, voltageV: 1.5 }],
  channelReference: { component: "U1", port: "A1" },
  boardConstruction,
  sourceProvenance,
}
