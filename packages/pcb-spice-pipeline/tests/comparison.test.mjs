import test from 'node:test'
import assert from 'node:assert/strict'
import {comparisonIdentity,assertComparable,sampleAtCrossings,comparisonAggressors,comparisonPairs,waveformDifference} from '../src/comparison.mjs'

function fixture(prefix='') {
  const port=name=>prefix+name
  const circuit=[{type:'source_component',source_component_id:port('driver'),name:'U1',manufacturer_part_number:'TX'},{type:'source_component',source_component_id:port('receiver'),name:'U3',manufacturer_part_number:'RX'},{type:'source_component',name:'V1',ftype:'simple_voltage_source',voltage:1.5}]
  for(const [component,names] of [['driver',['DQ','DQS','DQSn','VCC','GND']],['receiver',['DQ','DQS','DQSn','VCC','GND']]]) for(const name of names) circuit.push({type:'source_port',source_port_id:port(component+name),source_component_id:port(component),name})
  const geometry={mappings:['DQ','DQS','DQSn'].map(name=>({from:port('driver'+name),to:port('receiver'+name)}))}
  const plan={stimuli:['DQ','DQS','DQSn'].map(name=>({source_port_id:port('driver'+name),unit_interval_ms:.0000025,start_time_ms:name==='DQ'?0:.00000125,initial_state:0,inverted:name==='DQSn',pattern:{type:'bits',bits:name==='DQ'?'00010111':'01',repeat:true}}))}
  const assembly=['driver','receiver'].map(component=>({sourceSha256:component==='driver'?'a'.repeat(64):'b'.repeat(64),definition:{component,corner:'typical',packagePolicy:'omit'},metadata:{converterVersion:'0.0.2',tableExtrapolation:'hold-endpoint-current',pins:['DQ','DQS','DQSn'].map(name=>({port:port(component+name),physicalPin:name,model:'vendor-'+name,polarity:'non-inverting',runState:{mode:component==='driver'?'output':'input'},references:{pullup:port(component+'VCC'),pulldown:port(component+'GND'),powerClamp:port(component+'VCC'),groundClamp:port(component+'GND')}}))}}))
  const probe={signalSourceId:port('receiverDQ'),referenceSourceId:port('receiverGND')},samplingProbe={signalSourceId:port('receiverDQS'),referenceSourceId:port('receiverDQSn')}
  return {circuit,geometry,plan,assembly,probe,samplingProbe}
}

test('fair comparison follows physical pins when generated IDs change and permits extra neighbors',()=>{
  const old=fixture(),routed=fixture('new-')
  routed.geometry.mappings.push({from:'unused-driver-DQ1',to:'unused-receiver-DQ1'})
  assertComparable([comparisonIdentity(old),comparisonIdentity(routed)])
})

test('comparison refuses changed victim/strobe traffic, vendor models, corners, references and probes',()=>{
  const reference=comparisonIdentity(fixture())
  const changes=[
    run=>{run.plan.stimuli[0].pattern.bits='01'},
    run=>{run.plan.stimuli[1].start_time_ms=0},
    run=>{run.assembly[0].sourceSha256='c'.repeat(64)},
    run=>{run.assembly[1].metadata.pins[0].model='other-termination'},
    run=>{run.assembly[1].definition.corner='minimum'},
    run=>{run.assembly[0].definition.packagePolicy='vendor'},
    run=>{run.assembly[0].metadata.pins[0].references.powerClamp='driverGND'},
    run=>{run.assembly[0].metadata.pins[0].runState.mode='input'},
    run=>{run.probe.referenceSourceId='receiverVCC'},
    run=>{run.samplingProbe.signalSourceId='receiverDQSn';run.samplingProbe.referenceSourceId='receiverDQS'},
    run=>{run.circuit.find(component=>component.name==='V1').voltage=1.35},
  ]
  for(const change of changes) {
    const run=fixture();change(run)
    assert.throws(()=>assertComparable([reference,comparisonIdentity(run)]),/comparison_fairness/)
  }
})

test('comparison refuses unmodeled probe pins instead of assigning them a nearby model',()=>{
  const run=fixture();run.probe.signalSourceId='receiverGND'
  assert.throws(()=>comparisonIdentity(run),/comparison_binding/)
})

test('measured receive strobe sampling distinguishes applied histories from decoded histories',()=>{
  const result=sampleAtCrossings({rows:[[0,.2,-1],[.9,.2,1],[1.1,1.2,1],[1.9,1.2,-1],[2.1,1.2,-1],[2.9,1.2,1]],signalColumn:1,samplingColumn:2,thresholdV:.75,startSeconds:0,endSeconds:3,stimulus:{start_time_ms:0,unit_interval_ms:1000,inverted:false,pattern:{type:'bits',bits:'010',repeat:true}}})
  assert.equal(result.errors,1)
  assert.ok(result.minimumExpectedMarginV<0,'wrong bits must produce a signed negative margin')
  assert.deepEqual(result.expectedHistories,['010'])
  assert.deepEqual(result.histories,['011'])
})

function neighborCase(name,bits='0') {
  const run=fixture(),eye={startTimeSeconds:0,endTimeSeconds:20e-9}
  for(const [pin,pattern,initial] of [['N1',bits,0],['CKE','1',1]]) {
    for(const [i,component] of ['driver','receiver'].entries()) {
      run.circuit.push({type:'source_port',source_port_id:component+pin,source_component_id:component,name:pin})
      run.assembly[i].metadata.pins.push({...structuredClone(run.assembly[i].metadata.pins[0]),port:component+pin,physicalPin:pin})
    }
    run.geometry.mappings.push({from:'driver'+pin,to:'receiver'+pin})
    run.plan.stimuli.push({...structuredClone(run.plan.stimuli[0]),name:`${name}_${pin}`,source_port_id:'driver'+pin,initial_state:initial,pattern:{type:'bits',bits:pattern,repeat:true}})
  }
  const series=()=>({root:'routed',experimentName:name,label:name,aggressors:comparisonAggressors(run,eye)})
  return {run,series}
}

test('quiet/switching pairing uses activity and pin bindings rather than experiment order',()=>{
  const quiet=neighborCase('QUIET'),active=neighborCase('SWITCHING','01'),series=[active.series(),{root:'reduced',experimentName:'DDR_SI',label:'baseline',aggressors:[]},quiet.series()]
  const pairs=comparisonPairs(series)
  assert.equal(pairs.length,1);assert.equal(pairs[0].quietIndex,2);assert.equal(pairs[0].activeIndex,0)
  assert.deepEqual(pairs[0].switchingAggressors,[{component:'U1',pin:'N1',partNumber:'TX'}])
  const recorded=series[0].aggressors.find(pin=>pin.driver.pin.pin==='N1').stimulus
  assert.deepEqual(recorded,active.run.plan.stimuli.find(pin=>pin.source_port_id==='driverN1'),'complete serialized stimulus retained, including timing/inversion/source identity')
  assert.equal(series[0].aggressors.find(pin=>pin.driver.pin.pin==='CKE').activity.behavior,'constant')
})

test('case names cannot conceal switching, omitted aggressors, changed buffers or changed held bias',()=>{
  assert.throws(()=>comparisonPairs([neighborCase('QUIET','01').series()]),/comparison_case/)
  assert.throws(()=>comparisonPairs([neighborCase('SWITCHING','0').series()]),/comparison_case/)
  const missing=neighborCase('SWITCHING','01');missing.run.plan.stimuli.pop()
  assert.throws(()=>missing.series(),/comparison_aggressor/)
  const changed=neighborCase('SWITCHING','01');changed.run.assembly[1].metadata.pins.at(-1).model='other-termination'
  assert.throws(()=>comparisonPairs([neighborCase('QUIET').series(),changed.series()]),/comparison_aggressor/)
  const bias=neighborCase('SWITCHING','01');bias.run.plan.stimuli.at(-1).pattern.bits='0'
  assert.throws(()=>comparisonPairs([neighborCase('QUIET').series(),bias.series()]),/comparison_aggressor/)
  assert.throws(()=>comparisonPairs([neighborCase('QUIET').series(),neighborCase('QUIET').series(),neighborCase('SWITCHING','01').series()]),/comparison_case/)
  const late=neighborCase('SWITCHING','01');late.run.plan.stimuli.find(pin=>pin.source_port_id==='driverN1').start_time_ms=1
  assert.throws(()=>comparisonPairs([late.series()]),/comparison_case/,'switching only after the measured gate is not a switching case')
})

test('difference captures extrema at quiet-only knots and integrates the recorded PL square exactly',()=>{
  const delta=waveformDifference({quiet:[[0,0],[.5,1],[1,0]],active:[[0,0],[.2,0],[1,0]],quietColumn:1,activeColumn:1,startSeconds:0,endSeconds:1})
  assert.equal(delta.peakAbsoluteV,1);assert.equal(delta.peakTimeSeconds,.5);assert.equal(delta.minimumV,-1)
  assert.ok(Math.abs(delta.timeRmsV-Math.sqrt(1/3))<1e-12)
  assert.ok(Math.abs(delta.sampleRmsV-Math.sqrt(1.16/4))<1e-12)
  const cropped=waveformDifference({quiet:[[0,0],[.5,1],[1,0]],active:[[0,0],[1,0]],quietColumn:1,activeColumn:1,startSeconds:.1,endSeconds:.9})
  assert.equal(cropped.samples,3);assert.equal(cropped.peakAbsoluteV,1)
  assert.throws(()=>waveformDifference({quiet:[[0,0],[1,0]],active:[[.1,0],[1,0]],quietColumn:1,activeColumn:1,startSeconds:0,endSeconds:1}),/comparison_gate/)
})

function clockSampling(delay=.2) {
  const stimulus={unit_interval_ms:1000,start_time_ms:0,initial_state:0,inverted:false,pattern:{type:'bits',bits:'00010111',repeat:true}}
  const samplingStimulus={...structuredClone(stimulus),start_time_ms:500,pattern:{type:'bits',bits:'01',repeat:true}},samplingNegativeStimulus={...structuredClone(samplingStimulus),inverted:true}
  const rows=[[0,.2,-1]]
  for(let event=1;event<=5;event++) {
    const crossing=.5+event+delay,level=event%2?1:-1,voltage=stimulus.pattern.bits[event]==='1'?1.2:.2
    rows.push([crossing-.1,voltage,-level],[crossing+.1,voltage,level])
  }
  return {rows,signalColumn:1,samplingColumn:2,thresholdV:.75,startSeconds:0,endSeconds:9,stimulus,samplingStimulus,samplingNegativeStimulus}
}

test('strobe decoding validates startup source-edge identity and bounded arrival before assigning bits',()=>{
  const result=sampleAtCrossings(clockSampling())
  assert.equal(result.timingValidation.status,'validated-bounded-latency');assert.equal(result.errors,0)
  assert.deepEqual(result.samples.map(sample=>sample.bitIndex),[1,2,3,4,5])
  assert.ok(Math.abs(result.timingValidation.observedLatencyRangeSeconds[0]-.2)<1e-12)
  assert.equal(result.timingValidation.maximumLatencySeconds,.5)
  assert.throws(()=>sampleAtCrossings(clockSampling(.6)),/comparison_sampling_latency/)
  assert.throws(()=>sampleAtCrossings(clockSampling(2.2)),/comparison_sampling_latency/,'a full cycle delay must not alias onto later data bits')
  const missing=clockSampling();missing.rows.splice(3,4)
  assert.throws(()=>sampleAtCrossings(missing),/comparison_sampling_latency/,'missing two clock edges must not silently shift data-bit indexing')
  const missingTail=clockSampling();missingTail.rows.splice(7,4,[5.8,1.2,1])
  assert.throws(()=>sampleAtCrossings(missingTail),/comparison_sampling_latency/,'recorded tail must contain all edges required by the declared bound')
  assert.throws(()=>sampleAtCrossings({...clockSampling(),endSeconds:1}),/comparison_sampling_empty/)
  const late=clockSampling();late.rows=late.rows.slice(2)
  assert.throws(()=>sampleAtCrossings(late),/comparison_sampling_origin/)
})

test('a zero grazing point is not a strobe transition; a flat zero interval is ambiguous',()=>{
  const settings={...clockSampling(),samplingStimulus:undefined,samplingNegativeStimulus:undefined}
  assert.equal(sampleAtCrossings({...settings,rows:[[0,.2,-1],[1,.2,0],[2,.2,-1]]}).decodedBits,0)
  assert.throws(()=>sampleAtCrossings({...settings,rows:[[0,.2,-1],[1,.2,0],[2,.2,0],[3,.2,1]]}),/comparison_sampling_zero/)
})
