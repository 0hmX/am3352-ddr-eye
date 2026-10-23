import type { IbisModelDefinition } from "@tscircuit/props"
import lock from "../vendor-models.lock.json"

const vendor = lock.models.cmos
const ibisModelAsset = {
  project_relative_path: `models/${vendor.file}`,
  url: `./models/${vendor.file}`,
  mimetype: "text/plain",
}

export const outputPad: IbisModelDefinition = {
  ibisModelAsset, ibisComponentName: vendor.component,
  ibisPinNameToPortLabel: { "4": "Y", "5": "VCC", "3": "GND" },
  ibisPinNameToModelName: { "4": "LVC1G04_OUT_33" },
  ibisPinNameToReferencePortLabels: { "4": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" } },
  modelValueCorner: "typical", includePackageParasitics: false,
}
export const inputPad: IbisModelDefinition = {
  ibisModelAsset, ibisComponentName: vendor.component,
  ibisPinNameToPortLabel: { "2": "A", "5": "VCC", "3": "GND" },
  ibisPinNameToModelName: { "2": "LVC1G04_IN_33" },
  ibisPinNameToReferencePortLabels: { "2": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" } },
  modelValueCorner: "typical", includePackageParasitics: false,
}
