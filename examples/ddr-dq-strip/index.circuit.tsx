import type { PcbSpiceChannelProps } from "@tscircuit/props"
import { DdrDqBoard, routedDqChannel } from "../ddr-dq/index.circuit"

// The experiment, buffers, rails and saved routes are identical; only the
// extraction reduction changes to reproduce the pre-9a4fffd strip model.
const { groundMeshSize, ...extraction } = routedDqChannel.extraction

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

export default function Board() {
  return <DdrDqBoard channel={stripDqChannel} />
}
