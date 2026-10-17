import test from 'node:test'
import assert from 'node:assert/strict'
import {extractionConsistencyDiagnostics} from '../src/routed-extraction.mjs'

const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<=Math.max(Math.abs(expected)*1e-12,1e-24),`${actual} != ${expected}`)
const geometry={mappings:[
  {port:'DQ',pcbTraceId:'actual-dq',stages:[{kind:'wire',lengthMm:29.6},{kind:'via',lengthMm:.4}]},
  {port:'NEIGHBOR',pcbTraceId:'actual-neighbor',stages:[{kind:'wire',lengthMm:30}]},
]}
const er=4,k=.2,selfL=20e-9,idealDelay=.03*Math.sqrt(er)/299792458
// Homogeneous ideal coupled TEM line: L*C = idealDelay^2 * I.
const L=[[selfL,k*selfL],[k*selfL,selfL]],selfC=idealDelay**2/(selfL*(1-k*k))
const C=[[selfC,-k*selfC],[-k*selfC,selfC]],R=[[.2,0],[0,.2]]

test('coupled-line diagnostics retain routed lane order, active via length and the distinction between diagonal and modal delay',()=>{
  const diagnostics=extractionConsistencyDiagnostics({R,L,C,geometry,relativePermittivity:er})
  assert.deepEqual(diagnostics.signalOrder,['DQ','NEIGHBOR'])
  assert.deepEqual(diagnostics.pairs[0].signals,['DQ','NEIGHBOR'])
  near(diagnostics.pairs[0].inductiveCoupling,k);near(diagnostics.pairs[0].electrostaticCoupling,k)
  near(diagnostics.pairs[0].resistiveCoupling,0)
  for(const lane of diagnostics.lanes) {
    near(lane.routeLengthMm,30);near(lane.homogeneousIdealLineDelaySeconds,idealDelay)
    near(lane.diagonalLcDelayProxySeconds,idealDelay/Math.sqrt(1-k*k))
    near(lane.diagonalToIdealDelayRatio,1/Math.sqrt(1-k*k))
  }
  assert.equal(diagnostics.lanes[0].pcbTraceId,'actual-dq');near(diagnostics.lanes[0].activeViaLengthMm,.4)
  for(const sign of [-1,1]) near(Math.sqrt((L[0][0]+sign*L[0][1])*(C[0][0]+sign*C[0][1])),idealDelay)
  assert.match(diagnostics.interpretation,/not pass\/fail physical accuracy bounds/)
})

test('a shared return raises inductive and resistive coupling while unchanged electrostatic geometry retains its coupling',()=>{
  const sharedL=40e-9,sharedR=.3
  const diagnostics=extractionConsistencyDiagnostics({R:R.map(row=>row.map(value=>value+sharedR)),L:L.map(row=>row.map(value=>value+sharedL)),C,geometry,relativePermittivity:er})
  near(diagnostics.pairs[0].inductiveCoupling,(k*selfL+sharedL)/(selfL+sharedL))
  near(diagnostics.pairs[0].resistiveCoupling,sharedR/(R[0][0]+sharedR))
  near(diagnostics.pairs[0].electrostaticCoupling,k)
  assert.ok(diagnostics.pairs[0].inductiveCoupling>3*k)
  for(const lane of diagnostics.lanes) near(lane.diagonalToIdealDelayRatio,Math.sqrt((1+sharedL/selfL)/(1-k*k)))
  assert.throws(()=>extractionConsistencyDiagnostics({R,L,C,geometry:{mappings:geometry.mappings.slice(0,1)},relativePermittivity:er}),/saved routed lane order/)
})
