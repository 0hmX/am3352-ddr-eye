import test from 'node:test'
import assert from 'node:assert/strict'
import {comparisonIdentity,assertComparable,sampleAtCrossings} from '../src/comparison.mjs'

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
