import type { IbisModelDefinition } from "@tscircuit/ibis-to-spice"
import lock from "../vendor-models.lock.json"

const vendor = lock.models.cmos
const source = { url: vendor.url, sha256: vendor.archiveSha256,
  archive: { member: vendor.archivePath, memberSha256: vendor.sha256 } }

export const outputPad: IbisModelDefinition = {
  source, component: vendor.component,
  pinMap: { "4": "Y", "5": "VCC", "3": "GND" },
  modelSelections: { "4": "LVC1G04_OUT_33" },
  references: { "4": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" } },
  corner: "typical", packagePolicy: "omit",
}
export const inputPad: IbisModelDefinition = {
  source, component: vendor.component,
  pinMap: { "2": "A", "5": "VCC", "3": "GND" },
  modelSelections: { "2": "LVC1G04_IN_33" },
  references: { "2": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" } },
  corner: "typical", packagePolicy: "omit",
}
