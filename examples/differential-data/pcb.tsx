import type { TraceProps } from "@tscircuit/props"
import { Fragment } from "react"

/** Global board millimetres; convert once to the selected port's component coordinate frame. */
export function RoutedTrace({ from, to, origin, points, width = 0.25, name }: {
  from: string; to: string; origin: [number, number];
  points: Array<{ x: number; y: number; via?: boolean; fromLayer?: "top" | "bottom"; toLayer?: "top" | "bottom" }>;
  width?: number; name?: string;
}) {
  const path: TraceProps["pcbPath"] = [from, ...points.map(p => ({
    ...p, x: p.x - origin[0], y: p.y - origin[1],
  })), to]
  return <trace name={name} from={from} to={to} thickness={width} pcbPathRelativeTo={from} pcbPath={path} />
}

export function Soic8Pads() {
  return <footprint>{Array.from({ length: 8 }, (_, i) => {
    const pin = i + 1
    return <Fragment key={pin}><smtpad portHints={[`pin${pin}`]} pcbX={pin <= 4 ? -3 : 3}
      pcbY={pin <= 4 ? (2.5 - pin) * 1.27 : (pin - 6.5) * 1.27}
      width={1.6} height={0.6} shape="rect" /></Fragment>
  })}</footprint>
}

export function Sc70Pads() {
  const pads = [[1, -1.1, 0.65], [2, -1.1, 0], [3, -1.1, -0.65], [4, 1.1, -0.65], [5, 1.1, 0.65]]
  return <footprint>{pads.map(([pin, x, y]) => <Fragment key={pin}><smtpad
    portHints={[`pin${pin}`]} pcbX={x} pcbY={y} width={0.7} height={0.35} shape="rect" /></Fragment>)}</footprint>
}

export function BenchSupply() {
  return <>
    <chip name="PWR" pcbX={-22} pcbY={7} doNotPlace
    pinLabels={{ pin1: "VCC", pin2: "GND" }} footprint={<footprint>
      <smtpad portHints={["pin1"]} pcbX={-1} pcbY={0} width={1} height={1} shape="rect" />
      <smtpad portHints={["pin2"]} pcbX={1} pcbY={0} width={1} height={1} shape="rect" />
    </footprint>} />
    <voltagesource name="V_BENCH" voltage="3.3V" doNotPlace
      connections={{ pin1: ".PWR > .VCC", pin2: ".PWR > .GND" }} />
  </>
}
