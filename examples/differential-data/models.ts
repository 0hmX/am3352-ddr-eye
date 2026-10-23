import type { IbisModelDefinition } from "@tscircuit/props"
import lock from "../vendor-models.lock.json"

const vendor = lock.models.rs485
/** Reusable pad model: separate simulation declarations select TX/RX direction. */
export const rs485Pads: IbisModelDefinition = {
  ibisModelAsset: {
    project_relative_path: `models/${vendor.file}`,
    url: `./models/${vendor.file}`,
    mimetype: "text/plain",
  },
  ibisComponentName: vendor.component,
  ibisPinNameToPortLabel: { "6": "A", "7": "B", "8": "VCC", "5": "GND" },
  ibisPinNameToModelName: { "6": "a_b_p", "7": "a_b_n" },
  ibisPinNameToReferencePortLabels: {
    "6": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" },
    "7": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" },
  },
  modelValueCorner: "typical", includePackageParasitics: false,
}
