import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {generalSimulationSpice} from './general-spice.mjs'
import {probeWaveformRows} from './metrics.mjs'
import {command,json,sha256,hashes} from './io.mjs'
import {fail,validateMatrix} from './matrices.mjs'

// The difference is linear between consecutive knots in the union of both
// adaptive grids, so its absolute maximum occurs at one of those knots.
export function compareCapacitanceWaveforms({referenceRows,candidateRows,probes,startSeconds,endSeconds,maximumWaveformDifferenceV}) {
  if(!probes.length||!Number.isFinite(maximumWaveformDifferenceV)||maximumWaveformDifferenceV<=0||!Number.isFinite(startSeconds)||!Number.isFinite(endSeconds)||endSeconds<=startSeconds) fail('capacitance_sensitivity','Declared probes, explicit positive waveform budget and finite observation interval required')
  for(const rows of [referenceRows,candidateRows]) {
    if(rows.length<2||rows.some((row,i)=>row.length!==probes.length+1||row.some(value=>!Number.isFinite(value))||(i&&row[0]<=rows[i-1][0]))) fail('capacitance_sensitivity','Finite, strictly increasing actual waveform timestamps and all declared probe columns required')
    if(rows[0][0]>startSeconds||rows.at(-1)[0]<endSeconds) fail('capacitance_sensitivity','Incomplete waveform: comparison would require extrapolation')
  }
  const times=[...new Set([startSeconds,endSeconds,...referenceRows.map(row=>row[0]),...candidateRows.map(row=>row[0])].filter(time=>time>=startSeconds&&time<=endSeconds))].sort((a,b)=>a-b)
  const results=probes.map((probe,i)=>({name:probe.name,simulationVoltageProbeId:probe.simulationVoltageProbeId,column:i+1,maximumDifferenceV:0,timeSeconds:startSeconds,signedDifferenceV:0}))
  const indices=[0,0],grids=[referenceRows,candidateRows]
  for(const time of times) {
    const values=grids.map((rows,k)=>{
      while(indices[k]<rows.length-2&&rows[indices[k]+1][0]<time) indices[k]++
      const a=rows[indices[k]],b=rows[indices[k]+1],fraction=(time-a[0])/(b[0]-a[0])
      return a.map((value,column)=>column?value+(b[column]-value)*fraction:time)
    })
    for(const probe of results) {
      const difference=values[1][probe.column]-values[0][probe.column]
      if(!Number.isFinite(difference)) fail('capacitance_sensitivity','Nonfinite interpolated waveform difference')
      if(Math.abs(difference)>probe.maximumDifferenceV) Object.assign(probe,{maximumDifferenceV:Math.abs(difference),timeSeconds:time,signedDifferenceV:difference})
    }
  }
  const maximumDifferenceV=Math.max(...results.map(probe=>probe.maximumDifferenceV))
  return {passed:maximumDifferenceV<=maximumWaveformDifferenceV,maximumDifferenceV,maximumWaveformDifferenceV,startSeconds,endSeconds,unionTimestamps:times.length,probes:results,definition:'Exact maximum difference of the two piecewise-linear recorded waveforms over the union of their actual adaptive timestamps; no extrapolation'}
}

export async function runCapacitanceSensitivity({plan,geometry,modeling,extracted,models,nodes,electrical,tools,dir,referenceRows,onProgress=()=>{}}) {
  const corrected=extracted.filter(stage=>stage.capacitanceCorrection?.correctedPairs?.length)
  if(!corrected.length) return null
  const budgets=corrected.map(stage=>stage.capacitanceCorrection.policy.maximumWaveformDifferenceV)
  if(budgets.some(value=>!Number.isFinite(value)||value<=0)) fail('capacitance_sensitivity','Every correction requires an explicit positive maximumWaveformDifferenceV')
  const raw=extracted.map(stage=>stage.capacitanceCorrection?.correctedPairs?.length?{...stage,C:validateMatrix(stage.rawGroundedCapacitance,'Raw symmetric grounded capacitance diagnostic').matrix}:stage)
  const relative='numerical-capacitance-sensitivity',out=join(dir,relative)
  await mkdir(out)
  const bound={stages:corrected.map(stage=>({stage:stage.stage,...stage.capacitanceCorrection})),scope:'The capacitance energy bound is static. It does not bound dynamic voltage error; the separate native transient comparison measures that error for this declared experiment.'}
  await json(join(out,'bound.json'),bound)
  await writeFile(join(out,'simulation.cir'),generalSimulationSpice(plan,geometry,modeling,raw,models,nodes,electrical))
  onProgress(`Execute raw-capacitance numerical sensitivity transient for ${plan.name}`)
  await command(tools.ngspice,['-b','simulation.cir'],out,'ngspice')
  let bytes
  try {bytes=await readFile(join(out,'waveform.dat'))} catch(error) {
    if(error.code!=='ENOENT') throw error
    fail('capacitance_sensitivity',`${plan.name}: raw-capacitance native transient produced no waveform.dat`)
  }
  const rows=probeWaveformRows(bytes.toString('utf8'),plan.probes)
  await writeFile(join(out,'waveform.csv'),'time_s,'+plan.probes.map(probe=>probe.simulationVoltageProbeId+'_v').join(',')+'\n'+rows.map(row=>row.join(',')).join('\n')+'\n')
  const result={...compareCapacitanceWaveforms({referenceRows,candidateRows:rows,probes:plan.probes,startSeconds:plan.startTimeSeconds,endSeconds:plan.durationSeconds,maximumWaveformDifferenceV:Math.min(...budgets)}),directory:relative,numericalSolverInvocations:1,referenceWaveform:'../waveform.dat',referenceWaveformSha256:sha256(await readFile(join(dir,'waveform.dat'))),rawWaveformSha256:sha256(bytes),rawWaveformSamples:rows.length,staticBoundScope:bound.scope,files:await hashes(out)}
  await json(join(out,'receipt.json'),result)
  if(!result.passed) fail('capacitance_sensitivity',`${plan.name}: raw versus corrected capacitance changes a recorded probe by ${result.maximumDifferenceV} V, exceeding ${result.maximumWaveformDifferenceV} V; inspect ${out}`)
  return result
}
