import boardConstruction from "./board-construction.json"
import sourceProvenance from "../vendor-models.lock.json"

export const modeling = {
  ibisModelAssetSha256: { [`models/${sourceProvenance.models.cmos.file}`]: sourceProvenance.models.cmos.sha256 },
  reduction: "straightened-stages",
  conductivitySm: boardConstruction.copperConductivitySm,
  stackup: boardConstruction.copperLayers,
  lanes: [{ port: "DATA", from: { component: "TX", port: "Y" }, to: { component: "RX", port: "A" } }],
  channelReference: { component: "TX", port: "GND" },
  profiles: { top: {
    spacingMm: 1, relativePermittivity: 4.1,
    return: { widthMm: 0.35, thicknessMm: 0.035, lengthFactor: 1,
      centerYMm: -6, centerZMm: -1.565 },
  } },
  extraction: { minimumHz: 1, maximumHz: 1000000000, modelHz: 100000000,
    filaments: 11, refinementFilaments: 17, convergenceTolerance: 0.05,
    capTolerance: 0.02, maxPanelLengthMm: 2, reciprocityTolerance: 0.025,
    dcResistanceTolerance: 0.002 },
  sections: 12, boardConstruction, sourceProvenance,
  description: "Designed SN74LVC1G04 CMOS output-pad to input-pad board, explicit 20-Mbps data",
  modelingNotes: [
    "The real single top trace is reduced to its total length/width; the bottom return is a finite 0.35-mm strip at y=-6 mm and 1.565-mm copper-center separation.",
    "Ground escape bends, ground vias, excess return length, dielectric loss and surrounding copper are omitted; homogeneous epsilon_r=4.1 is assumed.",
    "IBIS supplies electrical pad behavior. Explicit stimulus controls the output pad directly; the inverter core, input-to-output propagation delay and receiver digital output are not simulated.",
  ],
}
