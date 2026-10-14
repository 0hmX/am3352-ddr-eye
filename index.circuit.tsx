import type { BoardProps } from "@tscircuit/props"
import routedBoard from "./am3352.circuit.json"
import { driver, receiver } from "./simulation.config"

export { modeling } from "./simulation.config"

export default function Board() {
  return (
    <board
      circuitJson={routedBoard as NonNullable<BoardProps["circuitJson"]>}
      routingDisabled
      schematicDisabled
      simIbisModels={{ U1: driver, U3: receiver }}
    >
      <eyediagram
        name="DDR_DQS0"
        positive=".U3 > .F3"
        negative=".U3 > .G3"
        unitInterval="2.5ns"
        duration="100ns"
        timeStep="10ps"
        startTime="20ns"
      />
    </board>
  )
}
