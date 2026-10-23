import type { IbisModelDefinition, PcbSpiceChannelProps } from "@tscircuit/props"

export const driver: IbisModelDefinition = {
  ibisModelAsset: {
    project_relative_path: "models/sprm552c.ibs",
    url: "./models/sprm552c.ibs",
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
    project_relative_path: "models/W631GG6MB-12.ibs",
    url: "./models/W631GG6MB-12.ibs",
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

export const routedDdrChannel: PcbSpiceChannelProps = {
  reduction: "routed-copper",
  sections: 12,
  lanes: [
    { name: "DQS", from: ".U1 > .P1", to: ".U3 > .F3" },
    { name: "DQSn", from: ".U1 > .P2", to: ".U3 > .G3" },
  ],
  referencePinRef: ".U1 > .A1",
  extraction: {
    minimumFrequency: "1Hz",
    maximumFrequency: "1GHz",
    modelFrequency: "100MHz",
    filaments: 7,
    refinementFilaments: 11,
    convergenceTolerance: 0.05,
    capacitanceTolerance: 0.02,
    reciprocityTolerance: 0.025,
    dcResistanceTolerance: 0.002,
    maxPanelLength: "2mm",
    groundMeshSize: "2mm",
  },
  relativePermittivity: 4.1,
  via: { platingThickness: "0.025mm", equivalentWidth: "0.1mm", omitThroughViaStubs: true },
}
