import { modeling as routedModeling } from "../ddr-dq/index.circuit"
import profiles from "./profiles.json"

// The experiment, buffers, rails and saved routes are identical; only the
// extraction reduction changes to reproduce the pre-9a4fffd strip model.
export { default } from "../ddr-dq/index.circuit"

export const modeling = {
  ...routedModeling,
  circuitJsonUnits: "mm",
  description: "Historical AM3352 DQ0 receiver eye: straightened stages, assumed 0.75mm spacing and artificial return strips",
  reduction: "straightened-stages",
  extraction: Object.fromEntries(
    Object.entries(routedModeling.extraction).filter(([key]) => key !== "groundMeshMm"),
  ),
  profiles,
  boardConstruction: {
    ...routedModeling.boardConstruction,
    extractionAssumptions: {
      ...routedModeling.boardConstruction.extractionAssumptions,
      profileSource: "examples/ddr-dq-strip/profiles.json (restored from 9a4fffd^ / 9ead6f7)",
      separationStatus: "Assumed uniform 0.75mm signal center spacing; original route spacing and bends are not modeled",
      returnConductor: "Artificial 2mm-wide, 35um-thick return strip at each historical profile offset; physical ground pours are excluded",
      permittivity: "Homogeneous effective er=2.55 on top, 4.1 on inner1/via; layered interfaces are not solved",
      omissions: [
        "Actual plane shape/cutouts, ground leads, reference stitching, bends and unselected neighboring nets",
        ...routedModeling.boardConstruction.extractionAssumptions.omissions.slice(2),
      ],
    },
  },
}
