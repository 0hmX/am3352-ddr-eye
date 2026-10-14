import test from 'node:test'
import assert from 'node:assert/strict'
import {useNativeIbis} from '../src/native-ibis.mjs'
test('silently stripped native ibisModel and swapped terminal source-port IDs fail closed',()=>{
  const cj=[],geometry={mappings:[{from:'d0',to:'r0'},{from:'d1',to:'r1'}]},modeling={lanes:[{port:'DQS'},{port:'DQSn'}]}
  const independent={driver:{source:'driver',spicePinMapping:{PAD0:'DQS',PAD1:'DQSn'}},receiver:{source:'receiver',spicePinMapping:{PAD0:'DQS',PAD1:'DQSn'}}}
  for(const role of ['d','r']) for(let i=0;i<2;i++) cj.push({type:'source_port',source_port_id:role+i,source_component_id:role})
  assert.throws(()=>useNativeIbis(cj,geometry,modeling,independent),/expected one native/)
  for(const [role,name] of [['d','driver'],['r','receiver']]) cj.push({type:'simulation_spice_subcircuit',source_component_id:role,subcircuit_source:name,spice_pin_to_source_port_map:{PAD0:role+'0',PAD1:role+'1'}})
  assert.equal(useNativeIbis(cj,geometry,modeling,independent).evidence.driver.usedNativeSourceForSimulation,true)
  cj.find(e=>e.type==='simulation_spice_subcircuit').spice_pin_to_source_port_map={PAD0:'d1',PAD1:'d0'}
  assert.throws(()=>useNativeIbis(cj,geometry,modeling,independent),/disagrees with selected/)
})
