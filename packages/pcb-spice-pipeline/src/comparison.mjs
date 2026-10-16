import {readFile,mkdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {runtimePaths,packageRoot} from './runtime.mjs'
import {command,json,sha256} from './io.mjs'
import {fail} from './matrices.mjs'

const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)

// Generated source IDs can change when annotations are added. Compare physical
// component/pin identities and the executed model, not the generated IDs.
export function comparisonIdentity({circuit,geometry,plan,assembly,probe,samplingProbe}) {
  const identity=sourceId=>{
    const port=circuit.find(record=>record.type==='source_port'&&record.source_port_id===sourceId)
    const component=circuit.find(record=>record.type==='source_component'&&record.source_component_id===port?.source_component_id)
    if(!port||!component) fail('comparison_binding',`Cannot identify physical probe/model port ${sourceId}`)
    return {component:component.name,pin:port.name,partNumber:component.manufacturer_part_number??null}
  }
  const modelAt=sourceId=>{
    const matches=assembly.flatMap(model=>model.metadata.pins.filter(pin=>pin.port===sourceId).map(pin=>({model,pin})))
    if(matches.length!==1) fail('comparison_binding',`Exactly one executed IBIS pin required for ${sourceId}`)
    const {model,pin}=matches[0]
    return {pin:identity(sourceId),ibisComponent:model.definition.component,sourceSha256:model.sourceSha256,model:pin.model,physicalPin:pin.physicalPin,corner:model.definition.corner,packagePolicy:model.definition.packagePolicy,converterVersion:model.metadata.converterVersion,tableExtrapolation:model.metadata.tableExtrapolation,polarity:pin.polarity,runState:pin.runState,references:Object.fromEntries(Object.entries(pin.references).map(([name,source])=>[name,identity(source)]))}
  }
  const pathAt=sourceId=>{
    const lane=geometry.mappings.find(lane=>lane.to===sourceId)
    if(!lane) fail('comparison_binding',`Probe ${sourceId} must observe the selected channel receiver`)
    const stimulus=plan.stimuli.find(stimulus=>stimulus.source_port_id===lane.from)
    if(!stimulus) fail('comparison_sampling',`Selected channel driver ${lane.from} has no declared stimulus`)
    const {unit_interval_ms,start_time_ms,initial_state,inverted,pattern}=stimulus
    return {driver:modelAt(lane.from),receiver:modelAt(lane.to),stimulus:{unit_interval_ms,start_time_ms,initial_state,inverted,pattern}}
  }
  const result={probe:{positive:identity(probe.signalSourceId),negative:identity(probe.referenceSourceId)},victim:pathAt(probe.signalSourceId),voltageSources:circuit.filter(record=>record.type==='source_component'&&record.ftype==='simple_voltage_source').map(({name,voltage})=>({name,voltage})).sort((a,b)=>a.name.localeCompare(b.name))}
  if(samplingProbe) result.sampling={positive:pathAt(samplingProbe.signalSourceId),negative:pathAt(samplingProbe.referenceSourceId)}
  return result
}

export function assertComparable(identities) {
  if(identities.some(identity=>canonical(identity)!==canonical(identities[0]))) fail('comparison_fairness','Compared runs must use identical victim/strobe physical pins, probe references, stimulus timing/pattern, executed vendor IBIS bytes/models/states/corners/package policy and ideal rail voltages')
}

export function sampleAtCrossings({rows,signalColumn,samplingColumn,thresholdV,startSeconds,endSeconds,stimulus,polarity='non-inverting'}) {
  const samples=[]
  for(let i=1;i<rows.length;i++) {
    const a=rows[i-1],b=rows[i],x=a[samplingColumn],y=b[samplingColumn]
    if((x<0)===(y<0)) continue
    const fraction=-x/(y-x),timeSeconds=a[0]+fraction*(b[0]-a[0])
    if(timeSeconds<startSeconds||timeSeconds>=endSeconds) continue
    const voltageV=a[signalColumn]+fraction*(b[signalColumn]-a[signalColumn])
    const bitIndex=Math.floor((timeSeconds-stimulus.start_time_ms/1000)/(stimulus.unit_interval_ms/1000))
    if(bitIndex<0||(!stimulus.pattern.repeat&&bitIndex>=stimulus.pattern.bits.length)) continue
    const expected=Number(stimulus.pattern.bits[bitIndex%stimulus.pattern.bits.length])^Number(stimulus.inverted)^Number(polarity==='inverting')
    samples.push({timeSeconds,voltageV,bitIndex,expected,decoded:Number(voltageV>thresholdV)})
  }
  const histories=[...new Set(samples.slice(2).flatMap((sample,i)=>samples[i].bitIndex+2===sample.bitIndex?[samples.slice(i,i+3).map(bit=>bit.decoded).join('')]:[]))].sort()
  const expectedHistories=[...new Set(samples.slice(2).flatMap((sample,i)=>samples[i].bitIndex+2===sample.bitIndex?[samples.slice(i,i+3).map(bit=>bit.expected).join('')]:[]))].sort()
  const ranges=[0,1].map(expected=>samples.filter(sample=>sample.expected===expected).map(sample=>sample.voltageV))
  return {samples,decodedBits:samples.length,errors:samples.filter(sample=>sample.decoded!==sample.expected).length,histories,expectedHistories,minimumThresholdDistanceV:samples.length?Math.min(...samples.map(sample=>Math.abs(sample.voltageV-thresholdV))):null,minimumExpectedMarginV:samples.length?Math.min(...samples.map(sample=>(sample.voltageV-thresholdV)*(sample.expected?1:-1))):null,expectedLevelRangesV:ranges.map(values=>values.length?[Math.min(...values),Math.max(...values)]:null),duplicateBitSamples:samples.length-new Set(samples.map(sample=>sample.bitIndex)).size,definition:'DQ sampled at both polarities of the measured differential receive-strobe zero crossing; explicit voltage threshold, no device aperture, Vref tracking or timing qualification'}
}

export function waveformDifference({quiet,active,quietColumn,activeColumn,startSeconds,endSeconds}) {
  let index=0,peakAbsoluteV=0,peakTimeSeconds=null,squared=0,count=0,minimumV=Infinity,maximumV=-Infinity
  for(const row of active) {
    const time=row[0]
    if(time<startSeconds||time>endSeconds) continue
    while(index<quiet.length-2&&quiet[index+1][0]<time) index++
    const a=quiet[index],b=quiet[index+1]
    if(time<a[0]||time>b[0]) fail('comparison_gate','Difference would extrapolate beyond the quiet waveform')
    const value=row[activeColumn]-(a[quietColumn]+(b[quietColumn]-a[quietColumn])*(time-a[0])/(b[0]-a[0]))
    if(Math.abs(value)>peakAbsoluteV) {peakAbsoluteV=Math.abs(value);peakTimeSeconds=time}
    minimumV=Math.min(minimumV,value);maximumV=Math.max(maximumV,value);squared+=value*value;count++
  }
  if(!count) fail('comparison_gate','No shared waveform samples in the requested gate')
  return {peakAbsoluteV,peakTimeSeconds,minimumV,maximumV,sampleRmsV:Math.sqrt(squared/count),samples:count,definition:'Active minus linearly interpolated quiet waveform at actual active timestamps; RMS is sample-weighted'}
}

export async function compareRuns({directories,outputDir,probeName,samplingProbeName,thresholdV,python}) {
  if(!directories||directories.length<2||!probeName) fail('comparison_input','Provide at least two run directories and --probe NAME')
  if(samplingProbeName&&!Number.isFinite(thresholdV)) fail('comparison_threshold','Sampling analysis requires an explicit --threshold V')
  const out=resolve(outputDir);await mkdir(out,{recursive:false})
  const series=[],waveforms=[]
  for(const directory of directories) {
    const root=resolve(directory),receiptPath=join(root,'receipt.json'),receiptBytes=await readFile(receiptPath),receipt=JSON.parse(receiptBytes)
    if(receipt.status!=='executed'||!receipt.experiments?.length) fail('comparison_run',`${root}: completed native general run required`)
    const artifact=async relative=>{
      const bytes=await readFile(join(root,relative))
      if(sha256(bytes)!==receipt.files?.[relative]) fail('comparison_provenance',`${root}: ${relative} differs from the completed run receipt`)
      return bytes
    }
    const geometry=JSON.parse(await artifact('geometry.json'))
    const circuit=JSON.parse(await artifact('inputs/circuit.json'))
    for(const experiment of receipt.experiments) {
      const probe=experiment.probes.find(probe=>probe.name===probeName)
      if(!probe) fail('comparison_probe',`${experiment.name}: probe ${probeName} not found`)
      const eye=experiment.eyes.find(eye=>eye.simulationVoltageProbeId===probe.simulationVoltageProbeId)
      if(!eye) fail('comparison_eye',`${experiment.name}: a declared eye for ${probeName} is required`)
      const waveformPath=join(root,experiment.directory,'waveform.csv'),waveformBytes=await artifact(join(experiment.directory,'waveform.csv'))
      const rows=waveformBytes.toString('utf8').trim().split(/\r?\n/).slice(1).map(line=>line.split(',').map(Number))
      waveforms.push(rows)
      const gated=rows.filter(row=>row[0]>=eye.startTimeSeconds&&row[0]<=eye.endTimeSeconds)
      const range=gated.reduce(([low,high],row)=>[Math.min(low,row[probe.column]),Math.max(high,row[probe.column])],[Infinity,-Infinity])
      const plan=JSON.parse(await artifact(join(experiment.directory,'experiment.json')))
      const assembly=JSON.parse(await artifact(experiment.assembly))
      await artifact(join(experiment.directory,eye.directory,'eye-data.csv'))
      if(eye.sourceSha256!==sha256(waveformBytes)) fail('comparison_provenance',`${experiment.name}: eye is not bound to the recorded waveform`)
      const clock=samplingProbeName?experiment.probes.find(probe=>probe.name===samplingProbeName):null
      if(samplingProbeName&&!clock) fail('comparison_sampling',`Sampling probe ${samplingProbeName} is missing`)
      const identity=comparisonIdentity({circuit,geometry,plan,assembly,probe,samplingProbe:clock})
      let sampling
      if(samplingProbeName) {
        const lane=geometry.mappings.find(lane=>lane.to===probe.signalSourceId||lane.from===probe.signalSourceId)
        const stimulus=plan.stimuli.find(stimulus=>stimulus.source_port_id===lane?.from)
        if(!clock||!stimulus) fail('comparison_sampling','Sampling probe or selected channel output stimulus is missing')
        const driver=assembly.flatMap(model=>model.metadata.pins).find(pin=>pin.port===lane.from)
        sampling=sampleAtCrossings({rows,signalColumn:probe.column,samplingColumn:clock.column,thresholdV,startSeconds:eye.startTimeSeconds,endSeconds:eye.endTimeSeconds,stimulus,polarity:driver?.polarity})
      }
      series.push({label:`${geometry.kind==='routed-shapes'?'Routed':'Reduced'} / ${experiment.name}`,root,receiptPath,receiptSha256:sha256(receiptBytes),waveformPath,waveformSha256:sha256(waveformBytes),probe,eye,eyeCsv:join(root,experiment.directory,eye.directory,'eye-data.csv'),voltageRangeV:range,sampling,identity,limitations:receipt.limitations,sourceTreeDirty:receipt.execution.sourceTreeDirty})
    }
  }
  const ui=series[0].eye.unitIntervalSeconds
  if(series.some(run=>Math.abs(run.eye.unitIntervalSeconds/ui-1)>1e-9)) fail('comparison_ui','Compared eyes require the same UI')
  for(const key of ['timeOriginSeconds','startTimeSeconds','endTimeSeconds']) if(series.some(run=>run.eye[key]!==series[0].eye[key])) fail('comparison_gate',`Compared eyes require the same ${key}`)
  assertComparable(series.map(run=>run.identity))
  const changes=[]
  for(let i=1;i<series.length;i++) if(series[i].root===series[i-1].root) changes.push({quiet:series[i-1].label,active:series[i].label,...waveformDifference({quiet:waveforms[i-1],active:waveforms[i],quietColumn:series[i-1].probe.column,activeColumn:series[i].probe.column,startSeconds:series[i].eye.startTimeSeconds,endSeconds:series[i].eye.endTimeSeconds})})
  const manifest={probeName,samplingProbeName,thresholdV,series,changes,fairness:'Identical victim/strobe physical pins, traffic, IBIS bytes/models/states/corners/package policy, probe references and ideal rail voltages verified before plotting',limitations:['Comparison of finite deterministic simulations, not measured noise, BER or device timing qualification','Reduced versus routed comparison changes geometry, dielectric approximation, reference treatment and passive neighbor loading; quiet versus switching uses the same extracted network','Measured-strobe-aligned eyes remove common strobe arrival shifts and use zero crossings without modeling receiver aperture, Vref or setup/hold limits']}
  const manifestPath=join(out,'comparison.json');await json(manifestPath,manifest)
  await command(python,[join(packageRoot,'scripts/plot-comparison.py'),manifestPath],out,'plot-comparison')
  return {directory:out,manifest:manifestPath,changes,series:series.map(({label,voltageRangeV,sampling})=>({label,voltageRangeV,sampledBits:sampling?.decodedBits,errors:sampling?.errors,expectedHistories:sampling?.expectedHistories,minimumExpectedMarginV:sampling?.minimumExpectedMarginV,expectedLevelRangesV:sampling?.expectedLevelRangesV}))}
}

export async function compareFromArgs(args) {
  const directories=[];let probeName,samplingProbeName,thresholdV,outputDir
  for(let i=0;i<args.length;i++) {
    const option=args[i]
    if(option==='--probe') probeName=args[++i]
    else if(option==='--sampling-probe') samplingProbeName=args[++i]
    else if(option==='--threshold') thresholdV=Number(args[++i])
    else if(option==='--out') outputDir=args[++i]
    else if(option.startsWith('--')) fail('comparison_option',`Unknown option ${option}`)
    else directories.push(option)
  }
  return compareRuns({directories,probeName,samplingProbeName,thresholdV,outputDir:outputDir??`dist/comparison-${Date.now()}`,...await runtimePaths()})
}
