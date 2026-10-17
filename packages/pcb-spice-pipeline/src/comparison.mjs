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

function stimulusActivity(stimulus,startSeconds,endSeconds) {
  const {pattern,initial_state,inverted}=stimulus,ui=stimulus.unit_interval_ms/1000,start=stimulus.start_time_ms/1000
  const values=new Set()
  if(startSeconds<start) values.add(initial_state^Number(inverted))
  const first=Math.max(0,Math.floor((startSeconds-start)/ui)),last=Math.ceil((endSeconds-start)/ui)-1
  if(!pattern.repeat&&last>=pattern.bits.length) fail('comparison_traffic','Nonrepeating aggressor does not cover the measurement gate')
  if(last>=first) for(let index=first;index<=Math.min(last,first+pattern.bits.length-1);index++) {
    values.add(Number(pattern.bits[index%pattern.bits.length])^Number(inverted))
  }
  return {behavior:values.size>1?'switching':'constant',stimulusLevels:[...values].sort()}
}

export function comparisonAggressors(input,eye) {
  const {geometry,plan,probe,samplingProbe}=input
  const protectedReceivers=new Set([probe.signalSourceId,samplingProbe?.signalSourceId,samplingProbe?.referenceSourceId])
  return geometry.mappings.filter(lane=>!protectedReceivers.has(lane.to)).map(lane=>{
    const stimuli=plan.stimuli.filter(stimulus=>stimulus.source_port_id===lane.from)
    if(stimuli.length!==1) fail('comparison_aggressor',`Neighbor ${lane.from} requires exactly one explicit driver stimulus`)
    const model=comparisonIdentity({...input,probe:{...probe,signalSourceId:lane.to},samplingProbe:null}).victim
    if(model.driver.runState.mode!=='output'||model.driver.runState.enabled===false||model.receiver.runState.mode!=='input') fail('comparison_aggressor',`Neighbor ${lane.from} requires an enabled output and input receiver`)
    return {driver:model.driver,receiver:model.receiver,stimulus:stimuli[0],activity:stimulusActivity(stimuli[0],eye.startTimeSeconds,eye.endTimeSeconds)}
  }).sort((a,b)=>canonical(a.driver.pin).localeCompare(canonical(b.driver.pin)))
}

export function comparisonPairs(series) {
  const groups=new Map(),pairs=[]
  for(const [index,run] of series.entries()) {
    const role=!run.aggressors.length?'baseline':run.aggressors.some(pin=>pin.activity.behavior==='switching')?'switching':'quiet'
    const named=run.experimentName.match(/(?:^|[_\s-])(QUIET|SWITCHING)(?:$|[_\s-])/i)?.[1].toLowerCase()
    if(named&&named!==role) fail('comparison_case',`${run.experimentName}: declared neighbor activity contradicts the experiment name`)
    run.caseRole=role
    if(!groups.has(run.root)) groups.set(run.root,[])
    groups.get(run.root).push(index)
  }
  for(const indices of groups.values()) {
    const quiet=indices.filter(index=>series[index].caseRole==='quiet'),active=indices.filter(index=>series[index].caseRole==='switching')
    if(indices.length===1) continue
    if(quiet.length!==1||!active.length||quiet.length+active.length!==indices.length) fail('comparison_case','Each compared multi-experiment run requires one quiet case and explicit switching cases')
    for(const activeIndex of active) {
      const quietIndex=quiet[0],a=series[quietIndex].aggressors,b=series[activeIndex].aggressors
      if(canonical(a.map(({driver,receiver})=>({driver,receiver})))!==canonical(b.map(({driver,receiver})=>({driver,receiver})))) fail('comparison_aggressor','Quiet and switching cases must have identical neighbor pins, models, references and buffer states')
      for(let i=0;i<a.length;i++) if(b[i].activity.behavior==='constant'&&canonical(a[i].activity.stimulusLevels)!==canonical(b[i].activity.stimulusLevels)) fail('comparison_aggressor','Held neighbor levels must remain fixed between quiet and switching cases')
      pairs.push({quietIndex,activeIndex,quiet:series[quietIndex].label,active:series[activeIndex].label,switchingAggressors:b.filter(pin=>pin.activity.behavior==='switching').map(pin=>pin.driver.pin)})
    }
  }
  return pairs
}

function samplingAssignments({rows,samplingColumn,crossings,stimulus,samplingStimulus,samplingNegativeStimulus,samplingPolarity='non-inverting',samplingNegativePolarity='non-inverting'}) {
  if(!samplingStimulus) return {validation:{status:'unvalidated',limitation:'Expected bit indices use absolute receive time without a declared source-strobe latency check'}}
  const ui=stimulus.unit_interval_ms/1000,start=stimulus.start_time_ms/1000,p=samplingStimulus,n=samplingNegativeStimulus
  const inverted=(clock,polarity)=>Number(clock.inverted)^Number(polarity==='inverting')
  if(!n||p.pattern.type!=='bits'||n.pattern.type!=='bits'||!p.pattern.repeat||!n.pattern.repeat||p.pattern.bits.length!==n.pattern.bits.length||p.unit_interval_ms!==n.unit_interval_ms||p.start_time_ms!==n.start_time_ms||Math.abs(p.unit_interval_ms/stimulus.unit_interval_ms-1)>1e-9) fail('comparison_sampling_clock','Expected-bit decoding requires declared complementary alternating strobes with the data UI')
  const positive=p.pattern.bits.split('').map(bit=>Number(bit)^inverted(p,samplingPolarity)),negative=n.pattern.bits.split('').map(bit=>Number(bit)^inverted(n,samplingNegativePolarity))
  const initial=p.initial_state^inverted(p,samplingPolarity),initialNegative=n.initial_state^inverted(n,samplingNegativePolarity)
  if(initial===initialNegative||positive.some((bit,i)=>bit===negative[i]||bit===positive[(i+1)%positive.length])) fail('comparison_sampling_clock','Expected-bit decoding requires complementary strobes, including initial levels, and one transition per UI')
  const clockStart=p.start_time_ms/1000,offset=(clockStart-start)/ui,baseBit=Math.floor(offset),phase=offset-baseBit
  if(!(phase>1e-9&&phase<1-1e-9)) fail('comparison_sampling_phase','Source-strobe transitions must be strictly inside each launched data UI')
  const firstEvent=positive[0]===initial?1:0,firstLaunch=clockStart+firstEvent*ui,initialRow=rows.find(row=>row[samplingColumn]!==0)
  if(!initialRow||initialRow[0]>=firstLaunch||Number(initialRow[samplingColumn]>0)!==initial) fail('comparison_sampling_origin','Recorded strobe must establish the declared initial differential level before its first launched transition')
  const tolerance=ui*1e-6,maximumLatencySeconds=(1-phase)*ui,assignments=[]
  const requiredEdges=Math.max(0,Math.floor((rows.at(-1)[0]-firstLaunch-maximumLatencySeconds)/ui+1e-9)+1)
  if(crossings.length<requiredEdges) fail('comparison_sampling_latency','Recorded receive strobe is missing edges that must have arrived within the supported latency bound')
  for(const [index,crossing] of crossings.entries()) {
    const event=firstEvent+index,launchTimeSeconds=clockStart+event*ui,latencySeconds=crossing.timeSeconds-launchTimeSeconds
    if(crossing.rising!==Boolean(positive[event%positive.length])||latencySeconds< -tolerance||latencySeconds>=maximumLatencySeconds-tolerance) fail('comparison_sampling_latency','Received strobe edges cannot be unambiguously assigned within the launched data UI; expected-bit decoding supports only validated causal strobe latency below the remaining UI phase (no cycle-latency compensation)')
    assignments.push({bitIndex:baseBit+event,launchTimeSeconds,strobeLatencySeconds:latencySeconds})
  }
  return {assignments,validation:{status:'validated-bounded-latency',sourcePhaseUi:phase,maximumLatencySeconds,observedLatencyRangeSeconds:assignments.length?[Math.min(...assignments.map(row=>row.strobeLatencySeconds)),Math.max(...assignments.map(row=>row.strobeLatencySeconds))]:null,definition:'All recorded receive-strobe crossings, including startup, match source-edge order and direction and arrive causally inside the same launched DQ UI; longer or ambiguous cycle latency is rejected, not decoded'}}
}

export function sampleAtCrossings({rows,signalColumn,samplingColumn,thresholdV,startSeconds,endSeconds,stimulus,polarity='non-inverting',...clock}) {
  const samples=[],crossings=[]
  let previous,zero,zeroCount=0
  for(const row of rows) {
    if(row[samplingColumn]===0) {if(previous) {zero??=row;zeroCount++}continue}
    if(previous&&(previous[samplingColumn]<0)!==(row[samplingColumn]<0)) {
      if(zeroCount>1) fail('comparison_sampling_zero','A flat zero-strobe interval does not identify a unique receive crossing')
      const fraction=-previous[samplingColumn]/(row[samplingColumn]-previous[samplingColumn])
      crossings.push({timeSeconds:zero?.[0]??previous[0]+fraction*(row[0]-previous[0]),voltageV:zero?.[signalColumn]??previous[signalColumn]+fraction*(row[signalColumn]-previous[signalColumn]),rising:row[samplingColumn]>0})
    }
    previous=row;zero=undefined;zeroCount=0
  }
  const timing=samplingAssignments({rows,samplingColumn,crossings,stimulus,...clock})
  for(const [index,crossing] of crossings.entries()) {
    const {timeSeconds,voltageV}=crossing
    if(timeSeconds<startSeconds||timeSeconds>=endSeconds) continue
    const bitIndex=timing.assignments?.[index].bitIndex??Math.floor((timeSeconds-stimulus.start_time_ms/1000)/(stimulus.unit_interval_ms/1000))
    if(bitIndex<0||(!stimulus.pattern.repeat&&bitIndex>=stimulus.pattern.bits.length)) continue
    const expected=Number(stimulus.pattern.bits[bitIndex%stimulus.pattern.bits.length])^Number(stimulus.inverted)^Number(polarity==='inverting')
    samples.push({timeSeconds,voltageV,bitIndex,expected,decoded:Number(voltageV>thresholdV),...timing.assignments?.[index]})
  }
  const histories=[...new Set(samples.slice(2).flatMap((sample,i)=>samples[i].bitIndex+2===sample.bitIndex?[samples.slice(i,i+3).map(bit=>bit.decoded).join('')]:[]))].sort()
  const expectedHistories=[...new Set(samples.slice(2).flatMap((sample,i)=>samples[i].bitIndex+2===sample.bitIndex?[samples.slice(i,i+3).map(bit=>bit.expected).join('')]:[]))].sort()
  if(clock.samplingStimulus&&!samples.length) fail('comparison_sampling_empty','No validated receive-strobe samples fall inside the measurement gate')
  const ranges=[0,1].map(expected=>samples.filter(sample=>sample.expected===expected).map(sample=>sample.voltageV))
  return {samples,decodedBits:samples.length,errors:samples.filter(sample=>sample.decoded!==sample.expected).length,histories,expectedHistories,minimumThresholdDistanceV:samples.length?Math.min(...samples.map(sample=>Math.abs(sample.voltageV-thresholdV))):null,minimumExpectedMarginV:samples.length?Math.min(...samples.map(sample=>(sample.voltageV-thresholdV)*(sample.expected?1:-1))):null,expectedLevelRangesV:ranges.map(values=>values.length?[Math.min(...values),Math.max(...values)]:null),duplicateBitSamples:samples.length-new Set(samples.map(sample=>sample.bitIndex)).size,timingValidation:timing.validation,definition:'DQ sampled at both polarities of the measured differential receive-strobe zero crossing; explicit voltage threshold, no device aperture, Vref tracking or timing qualification'}
}

export function waveformDifference({quiet,active,quietColumn,activeColumn,startSeconds,endSeconds}) {
  for(const [rows,column] of [[quiet,quietColumn],[active,activeColumn]]) {
    if(rows.length<2||rows.some((row,i)=>!Number.isFinite(row[0])||!Number.isFinite(row[column])||(i&&row[0]<=rows[i-1][0]))) fail('comparison_waveform','Comparison requires finite recorded samples with strictly increasing timestamps')
    if(startSeconds<rows[0][0]||endSeconds>rows.at(-1)[0]) fail('comparison_gate','Difference gate would extrapolate beyond a recorded waveform')
  }
  if(!(endSeconds>startSeconds)) fail('comparison_gate','Difference requires a nonempty finite gate')
  const times=[...new Set([startSeconds,endSeconds,...quiet.filter(row=>row[0]>startSeconds&&row[0]<endSeconds).map(row=>row[0]),...active.filter(row=>row[0]>startSeconds&&row[0]<endSeconds).map(row=>row[0])])].sort((a,b)=>a-b)
  let quietIndex=0,activeIndex=0,peakAbsoluteV=0,peakTimeSeconds=null,squared=0,integral=0,previous,minimumV=Infinity,maximumV=-Infinity
  const interpolate=(rows,column,index,time)=>{
    const a=rows[index],b=rows[index+1]
    return a[column]+(b[column]-a[column])*(time-a[0])/(b[0]-a[0])
  }
  for(const time of times) {
    while(quietIndex<quiet.length-2&&quiet[quietIndex+1][0]<time) quietIndex++
    while(activeIndex<active.length-2&&active[activeIndex+1][0]<time) activeIndex++
    const value=interpolate(active,activeColumn,activeIndex,time)-interpolate(quiet,quietColumn,quietIndex,time)
    if(Math.abs(value)>peakAbsoluteV) {peakAbsoluteV=Math.abs(value);peakTimeSeconds=time}
    if(previous) integral+=(time-previous.time)*(previous.value**2+previous.value*value+value**2)/3
    minimumV=Math.min(minimumV,value);maximumV=Math.max(maximumV,value);squared+=value*value;previous={time,value}
  }
  return {peakAbsoluteV,peakTimeSeconds,minimumV,maximumV,timeRmsV:Math.sqrt(integral/(endSeconds-startSeconds)),sampleRmsV:Math.sqrt(squared/times.length),samples:times.length,definition:'Switching minus quiet piecewise-linear reconstructions of recorded adaptive samples on their union timestamp grid plus exact gate endpoints; peak and timeRmsV are exact for those recorded reconstructions, not a bound on unrecorded analog behavior; sampleRmsV is union-grid sample-weighted'}
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
      const aggressors=comparisonAggressors({circuit,geometry,plan,assembly,probe,samplingProbe:clock},eye)
      let sampling
      if(samplingProbeName) {
        const lane=geometry.mappings.find(lane=>lane.to===probe.signalSourceId||lane.from===probe.signalSourceId)
        const stimulus=plan.stimuli.find(stimulus=>stimulus.source_port_id===lane?.from)
        if(!clock||!stimulus) fail('comparison_sampling','Sampling probe or selected channel output stimulus is missing')
        const driver=assembly.flatMap(model=>model.metadata.pins).find(pin=>pin.port===lane.from)
        sampling=sampleAtCrossings({rows,signalColumn:probe.column,samplingColumn:clock.column,thresholdV,startSeconds:eye.startTimeSeconds,endSeconds:eye.endTimeSeconds,stimulus,polarity:driver?.polarity,samplingStimulus:identity.sampling.positive.stimulus,samplingNegativeStimulus:identity.sampling.negative.stimulus,samplingPolarity:identity.sampling.positive.driver.polarity,samplingNegativePolarity:identity.sampling.negative.driver.polarity})
      }
      series.push({label:`${geometry.kind==='routed-shapes'?'Routed':'Reduced'} / ${experiment.name}`,experimentName:experiment.name,root,receiptPath,receiptSha256:sha256(receiptBytes),waveformPath,waveformSha256:sha256(waveformBytes),probe,eye,eyeCsv:join(root,experiment.directory,eye.directory,'eye-data.csv'),voltageRangeV:range,sampling,identity,aggressors,limitations:receipt.limitations,sourceTreeDirty:receipt.execution.sourceTreeDirty,executionTimestampUtc:receipt.execution.timestampUtc})
    }
  }
  const ui=series[0].eye.unitIntervalSeconds
  if(series.some(run=>Math.abs(run.eye.unitIntervalSeconds/ui-1)>1e-9)) fail('comparison_ui','Compared eyes require the same UI')
  for(const key of ['timeOriginSeconds','startTimeSeconds','endTimeSeconds']) if(series.some(run=>run.eye[key]!==series[0].eye[key])) fail('comparison_gate',`Compared eyes require the same ${key}`)
  assertComparable(series.map(run=>run.identity))
  const changes=comparisonPairs(series).map(pair=>({...pair,startSeconds:series[pair.activeIndex].eye.startTimeSeconds,endSeconds:series[pair.activeIndex].eye.endTimeSeconds,...waveformDifference({quiet:waveforms[pair.quietIndex],active:waveforms[pair.activeIndex],quietColumn:series[pair.quietIndex].probe.column,activeColumn:series[pair.activeIndex].probe.column,startSeconds:series[pair.activeIndex].eye.startTimeSeconds,endSeconds:series[pair.activeIndex].eye.endTimeSeconds})}))
  const manifest={probeName,samplingProbeName,thresholdV,series,changes,fairness:'Identical victim/strobe physical pins, traffic, IBIS bytes/models/states/corners/package policy, probe references and ideal rail voltages verified before plotting; quiet/switching pairs selected from recorded neighbor activity with unchanged neighbor buffer models and held levels',limitations:['Comparison of finite deterministic simulations, not measured noise, BER or device timing qualification','Reduced versus routed comparison changes geometry, dielectric approximation, reference treatment and passive neighbor loading; quiet versus switching uses the same extracted network','Switching-minus-quiet includes all coupling and shared return paths represented by the declared reference contacts; it does not isolate trace-to-trace crosstalk or bound physical-board noise','Measured-strobe-aligned eyes remove common strobe arrival shifts; expected-bit decoding additionally requires validated source-edge ordering and sub-UI arrival bounds, with no cycle-latency compensation, receiver aperture, Vref tracking or setup/hold limits']}
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
