import type { IbisModelProps } from "@tscircuit/props"
import settings from "./simulation.json"
import boardConstruction from "./board-construction.json"
import sourceProvenance from "./source-provenance.json"

const [ti, winbond] = settings.vendors

export const driver: IbisModelProps = {
  sourceUrl: ti.url,
  archivePath: ti.archivePath,
  sha256: ti.sha256,
  component: "am335x_zcz",
  pins: {
    P1: { pin: "P1", model: "Model_655", mode: "output",
      stimulus: { type: "clock", period: "5ns", duration: "100ns" } },
    P2: { pin: "P2", model: "Model_847", mode: "output",
      stimulus: { type: "clock", period: "5ns", duration: "100ns", inverted: true } },
  },
  power: { vdd: "E5", vss: "A1" },
  corner: "typical",
  packageModel: "none",
}

export const receiver: IbisModelProps = {
  sourceUrl: winbond.url,
  archivePath: winbond.archivePath,
  sha256: winbond.sha256,
  component: "W631GG6MB-12",
  pins: {
    F3: { pin: "F3", model: "ODT_60", mode: "input" },
    G3: { pin: "G3", model: "ODT_60", mode: "input" },
  },
  power: { vdd: "A1", vss: "B1" },
  corner: "typical",
  packageModel: "pin_rlc",
}

export const modeling = {
  ...settings,
  stackup: boardConstruction.copperLayers,
  driver,
  receiver,
  boardConstruction,
  sourceProvenance,
}
