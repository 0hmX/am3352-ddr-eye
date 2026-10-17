import type { IbisModelDefinition } from "@tscircuit/ibis-to-spice"
import lock from "../vendor-models.lock.json"

const vendor = lock.models.rs485
/** Reusable pad model: separate simulation declarations select TX/RX direction. */
export const rs485Pads: IbisModelDefinition = {
  source: { url: vendor.url, sha256: vendor.archiveSha256,
    archive: { member: vendor.archivePath, memberSha256: vendor.sha256 } },
  component: vendor.component,
  pinMap: { "6": "A", "7": "B", "8": "VCC", "5": "GND" },
  modelSelections: { "6": "a_b_p", "7": "a_b_n" },
  references: {
    "6": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" },
    "7": { pullup: "VCC", pulldown: "GND", powerClamp: "VCC", groundClamp: "GND" },
  },
  corner: "typical", packagePolicy: "omit",
}
