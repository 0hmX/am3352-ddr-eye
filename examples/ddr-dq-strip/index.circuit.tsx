import type { PcbSpiceChannelProps } from "@tscircuit/props"
import { DdrDqBoard, routedDqChannel } from "../ddr-dq/index.circuit"

const { groundMeshSize, ...extraction } = routedDqChannel.extraction

// Historical pre-9a4fffd strip model (restored from 9ead6f7). These are NOT
// board geometry: each routed stage is straightened, signals are assumed to sit
// on a uniform 0.75 mm pitch, and the physical GND pours are replaced by an
// artificial 2 mm x 35 um return strip per layer profile. Effective εr is 2.55
// on top (mixed air/FR-4) and 4.1 on inner1/vias; layered interfaces are not solved.
const stripReturn = (centerZ: string) =>
  ({ width: "2mm", thickness: "0.035mm", lengthFactor: 1, centerY: "0mm", centerZ })

export const stripDqChannel: PcbSpiceChannelProps = {
  ...routedDqChannel,
  reduction: "straightened-stages",
  extraction,
  straightenedStageProfiles: {
    top: { spacing: "0.75mm", relativePermittivity: 2.55, return: stripReturn("-0.2mm") },
    inner1: { spacing: "0.75mm", relativePermittivity: 4.1, return: stripReturn("0.1245mm") },
    via: { spacing: "0.75mm", relativePermittivity: 4.1, return: stripReturn("-0.2mm") },
  },
}

/** Same experiments, buffers, rails and saved routes as ../ddr-dq; only the extraction differs. */
export default function Board() {
  return <DdrDqBoard channel={stripDqChannel} />
}
