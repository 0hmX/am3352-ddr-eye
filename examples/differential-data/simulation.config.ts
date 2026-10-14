import boardConstruction from "./board-construction.json"
import sourceProvenance from "../vendor-models.lock.json"

export const modeling = {
  circuitJsonUnits: "mm", reduction: "straightened-stages",
  conductivitySm: boardConstruction.copperConductivitySm,
  stackup: boardConstruction.copperLayers,
  lanes: [
    { port: "A", from: { component: "TX", port: "A" }, to: { component: "RX", port: "A" } },
    { port: "B", from: { component: "TX", port: "B" }, to: { component: "RX", port: "B" } },
  ],
  channelReference: { component: "TX", port: "GND" },
  passiveComponents: [{ component: "RTERM" }],
  profiles: { top: {
    spacingMm: 6, relativePermittivity: 4.1,
    return: { widthMm: 0.35, thicknessMm: 0.035, lengthFactor: 1,
      centerYMm: -6, centerZMm: -1.565 },
  } },
  extraction: { minimumHz: 1, maximumHz: 100000000, modelHz: 1000000,
    filaments: 7, refinementFilaments: 11, convergenceTolerance: 0.05,
    capTolerance: 0.02, maxPanelLengthMm: 2, reciprocityTolerance: 0.025,
    dcResistanceTolerance: 0.002 },
  sections: 12, boardConstruction, sourceProvenance,
  description: "Designed SN65HVD72 RS-485 pad/channel board, 250 kbps explicit data",
  modelingNotes: [
    "Native top signal traces include bends; extraction preserves total length/width and straightens them into parallel strips with 6-mm center spacing.",
    "Finite bottom return strip uses the stated 0.35-mm ground-route width, bottom copper separation and y=-6-mm main segment. Ground escape bends, vias and excess length are omitted.",
    "Homogeneous epsilon_r=4.1 is an explicit FR-4 assumption; air fields, dielectric loss, neighboring copper and package coupling are outside this reduction.",
    "120-ohm RTERM is a real routed TSX resistor at the receiver, included by declared passive scope. This is one terminated point-to-point experiment, not an RS-485 compliance or receiver-logic test.",
  ],
}
