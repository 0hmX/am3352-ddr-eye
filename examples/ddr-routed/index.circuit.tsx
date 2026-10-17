import type { BoardProps, IbisModelDefinition } from "@tscircuit/props"
import { analog } from "tscircuit"
import routedBoard from "../../am3352.circuit.json"
import { driver as dqDriver, receiver as dqReceiver, modeling as dqModeling } from "../ddr-dq/index.circuit"

// Physical DDR pins from the TI and Winbond vendor component tables.
const neighbors = [
  { name: "DQ1", tx: "M4", rx: "F7" },
  { name: "DQ2", tx: "N1", rx: "F2" },
  { name: "DQ3", tx: "N2", rx: "F8" },
  { name: "DQ4", tx: "N3", rx: "H3" },
  { name: "DQ5", tx: "N4", rx: "H8" },
  { name: "DQ6", tx: "P3", rx: "G2" },
  { name: "DQ7", tx: "P4", rx: "H7" },
  { name: "DM0", tx: "M2", rx: "E7" },
  { name: "DM1", tx: "J2", rx: "D3" },
  { name: "DQ9", tx: "K1", rx: "C3" },
]
// DQM1, DQ9 and CKE follow DQ0 for >2mm within a 0.5mm same-layer edge gap.
// Retain CKE's copper and input loading, held high during active DDR traffic.
const selectedPins = [...neighbors, { name: "CKE", tx: "G3", rx: "K9" }]
const driver: IbisModelDefinition = {
  ...dqDriver,
  pinMap: { ...dqDriver.pinMap, ...Object.fromEntries(selectedPins.map(pin => [pin.tx, pin.tx])) },
  modelSelections: { ...dqDriver.modelSelections, ...Object.fromEntries(selectedPins.map(pin => [pin.tx, "Model_343"])) },
  references: { ...dqDriver.references, ...Object.fromEntries(selectedPins.map(pin => [pin.tx, { pullup: "E5", pulldown: "A1", powerClamp: "E5", groundClamp: "A1" }])) },
}
const receiver: IbisModelDefinition = {
  ...dqReceiver,
  pinMap: { ...dqReceiver.pinMap, ...Object.fromEntries(selectedPins.map(pin => [pin.rx, pin.rx])) },
  modelSelections: { ...dqReceiver.modelSelections, ...Object.fromEntries(selectedPins.map(pin => [pin.rx, pin.name === "CKE" ? "CMD" : "ODT_60"])) },
  references: { ...dqReceiver.references, ...Object.fromEntries(selectedPins.map(pin => [pin.rx, { pullup: "A1", pulldown: "B1", powerClamp: "A1", groundClamp: "B1" }])) },
}

// Every saved-board contact in the selected digital-ground/DDR-supply domains,
// checked against vendor [Pin] tables. packagePolicy="omit" assumes ideal common
// digital ground and supply nodes at each package; no package/PDN impedance.
// U1 excludes RTC/ADC/oscillator/USB grounds, VPP, and non-ground pins tied to GND.
const referenceContacts = [
  {
    name: "GND",
    sourceBalls: [
      "A1", "V1", "H6", "J6", "M6", "H7", "J7", "K7", "M7", "N7",
      "F8", "G8", "H8", "J8", "M8", "G9", "H9", "J9", "K9", "M9",
      "H10", "J10", "K10", "L10", "M10", "N10", "G11", "J11", "K11", "L11",
      "N11", "G12", "H12", "L12", "M12", "L13", "A18", "V18",
    ],
    receiverBalls: [
      "B1", "D1", "E1", "G1", "M1", "P1", "T1", "E2", "J2", "B3", "D8",
      "E8", "G8", "J8", "A9", "B9", "F9", "G9", "M9", "P9", "T9",
    ],
  },
  {
    name: "DDR_1V5",
    sourceBalls: ["E5", "F5", "G5", "H5", "J5", "K5", "L5"], // VDDS_DDR; excludes VDDS_PLL_DDR.
    receiverBalls: [
      "A1", "C1", "F1", "N1", "R1", "B2", "D2", "H2", "K2",
      "G7", "A8", "K8", "C9", "D9", "E9", "H9", "N9", "R9",
    ],
  },
]

export const modeling = {
  ...dqModeling,
  circuit: "../../am3352.circuit.json",
  description: "Actual routed DDR byte, nearest parallel neighbors and reference pours; quiet/switching traffic; explicit homogeneous dielectric approximation",
  reduction: "routed-shapes",
  omitThroughViaStubs: false,
  sections: 32,
  boardConstruction: {
    ...dqModeling.boardConstruction,
    extractionAssumptions: {
      conductivitySm: dqModeling.conductivitySm,
      viaPlatingMm: 0.025,
      omitThroughViaStubs: false,
      returnConductor: "Saved GND and DDR_1V5 polygons, contacted at every declared digital-ground/DDR-supply ball; ideal package nodes and ideal AC rail joins at each chip",
      separationStatus: "Actual routed coordinates; no imposed uniform signal spacing",
      permittivity: "Explicit homogeneous er=4.1 for thin-sheet capacitance; layer heights follow the declared construction",
      frequencyHz: 100000000,
      omissions: ["Package/PDN impedance", "Dielectric loss and roughness", "Broadband dispersion", "Unselected board signals", "Dielectric interfaces and finite thickness in capacitance"],
    },
  },
  lanes: [
    ...dqModeling.lanes,
    ...selectedPins.map(pin => ({ port: pin.name, driverPort: pin.tx, receiverPort: pin.rx,
      from: { component: "U1", port: pin.tx }, to: { component: "U3", port: pin.rx } })),
  ],
  routedExtraction: {
    marginMm: 2,
    referenceMeshMm: 0.5,
    referenceBoundaryToleranceMm: 0.025,
    impedanceSurfaceToleranceMm: 0.001,
    surfaceToleranceMm: 0.003,
    coordinateGridMm: 0.002,
    maximumPanelLengthMm: 0.5,
    signalFilaments: 3,
    dielectricLossTangent: 0,
    homogeneousRelativePermittivity: 4.1,
    capacitanceGeometry: "thin-sheets",
    capMeshEpsilons: [1, 0.5, 0.25],
    capInteractionRatio: 0.03,
    capLinearTolerance: 0.000001,
    // Bound unresolved numerical mutuals, and verify their actual waveform effect.
    capacitanceCorrection: {
      maximumEnergyFraction: 0.001,
      maximumWaveformDifferenceV: 0.001,
    },
    // Cycling the shorter list only fills the pair schema; every ball participates.
    referencePorts: referenceContacts.flatMap(({ name, sourceBalls, receiverBalls }) =>
      Array.from({ length: Math.max(sourceBalls.length, receiverBalls.length) }, (_, index) => ({
        name,
        from: { component: "U1", port: sourceBalls[index % sourceBalls.length] },
        to: { component: "U3", port: receiverBalls[index % receiverBalls.length] },
      }))),
  },
}

const outputPins = ["M3", "P1", "P2", ...selectedPins.map(pin => pin.tx)]
const inputPins = ["E3", "F3", "G3", ...selectedPins.map(pin => pin.rx)]
const states = {
  ...Object.fromEntries(outputPins.map(pin => [`.U1 > .${pin}`, { mode: "output" as const, enabled: true }])),
  ...Object.fromEntries(inputPins.map(pin => [`.U3 > .${pin}`, { mode: "input" as const }])),
}

export default function Board() {
  return <board circuitJson={routedBoard as NonNullable<BoardProps["circuitJson"]>} routingDisabled schematicDisabled>
    <ibismodel componentRef=".U1" {...driver} />
    <ibismodel componentRef=".U3" {...receiver} />
    <voltagesource name="V1" doNotPlace voltage="1.5V" connections={{ pos: ".U1 > .E5", neg: ".U1 > .A1" }} />
    {["QUIET", "SWITCHING"].flatMap(experiment => [
      <analog.transientsimulation key={`${experiment}_run`} name={experiment} duration="160ns" timePerStep="10ps" ibisPinStates={states} />,
      <analog.digitalstimulus key={`${experiment}_DQ0`} name={`${experiment}_DQ0`} simulationRef={`.${experiment}`} drives=".U1 > .M3"
        unitInterval="2.5ns" startTime="0ns" initialState={0} pattern={{ type: "bits", bits: "00010111", repeat: true }} />,
      <analog.digitalstimulus key={`${experiment}_DQS`} name={`${experiment}_DQS`} simulationRef={`.${experiment}`} drives=".U1 > .P1"
        unitInterval="2.5ns" startTime="1.25ns" initialState={0} pattern={{ type: "bits", bits: "01", repeat: true }} />,
      <analog.digitalstimulus key={`${experiment}_DQSN`} name={`${experiment}_DQSN`} simulationRef={`.${experiment}`} drives=".U1 > .P2"
        unitInterval="2.5ns" startTime="1.25ns" initialState={0} inverted pattern={{ type: "bits", bits: "01", repeat: true }} />,
      <analog.digitalstimulus key={`${experiment}_CKE`} name={`${experiment}_CKE`} simulationRef={`.${experiment}`} drives=".U1 > .G3"
        unitInterval="2.5ns" startTime="0ns" initialState={1} pattern={{ type: "bits", bits: "1", repeat: true }} />,
      // Simultaneous opposite-direction neighbor traffic is an explicit stress case.
      ...neighbors.map(pin => <analog.digitalstimulus key={`${experiment}_${pin.name}`} name={`${experiment}_${pin.name}`}
        simulationRef={`.${experiment}`} drives={`.U1 > .${pin.tx}`} unitInterval="2.5ns" startTime="0ns" initialState={0}
        inverted={experiment === "SWITCHING"}
        pattern={{ type: "bits", bits: experiment === "QUIET" ? "0" : "00010111", repeat: true }} />),
      <analog.eyediagram key={`${experiment}_DQ0_EYE`} name={`${experiment}_DQ0_EYE`} simulationRef={`.${experiment}`} probeRef=".DQ0_RX"
        unitInterval="2.5ns" timeOrigin="0ns" startTime="40ns" />,
    ])}
    <voltageprobe name="DDR_RX" connectsTo=".U3 > .F3" referenceTo=".U3 > .G3" />
    <voltageprobe name="DQ0_RX" connectsTo=".U3 > .E3" referenceTo=".U3 > .B1" />
    <voltageprobe name="DQ0_TX" connectsTo=".U1 > .M3" referenceTo=".U1 > .A1" />
    <voltageprobe name="DM1_RX" connectsTo=".U3 > .D3" referenceTo=".U3 > .B1" />
    <voltageprobe name="DQ9_RX" connectsTo=".U3 > .C3" referenceTo=".U3 > .B1" />
  </board>
}
