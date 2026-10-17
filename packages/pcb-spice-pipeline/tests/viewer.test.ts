import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {writeViewerData} from '../src/viewer.js'
import type {ReportData} from '../src/report.js'
import {reportContext} from '../src/report.js'
import {geometryFromCircuitJson,type Modeling} from '../src/geometry.js'
import type {CircuitJson} from '../src/schema.js'

test('portable results retain raw adaptive samples and escape embedded names',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pcb-viewer-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const path=join(directory,'results.html'),name='</script><script>throw Error("untrusted")</script>'
  const data={runs:[{name,rows:[[0,0],[.17,5],[1,1]],probes:[{name:'P',column:1}],eyes:[]}],limitations:['finite model']}
  await writeViewerData(path,data,name)
  const html=await readFile(path,'utf8')
  assert.ok(!html.includes(name),'untrusted names cannot break out of an HTML or script element')
  const serialized=html.match(/id="simulation-data">([\s\S]*?)<\/script>/)![1]
  assert.deepEqual(JSON.parse(serialized),data,'full sample timestamps and values are preserved')
  assert.doesNotMatch(html,/<script[^>]+src=|https?:\/\//,'viewer needs no network resources')
})

test('report maps physical traces and probes, exports every recorded sample and preserves eye CSV bytes',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'pcb-report-'));t.after(()=>rm(directory,{recursive:true,force:true}))
  const eyeCsv='window,folded_time_s,time_s,voltage_v\n0,0,0.17,5\n'
  const data: ReportData={context:{description:'Trace <DQ> test',ports:{tx:'U1.M3',rx:'U3.E3',gnd:'U3.B1'},
    lanes:[{name:'DQ0',from:'tx',to:'rx',sourceTraceId:'source_trace_14',pcbTraceId:'route14',lengthMm:45.25,
      layers:['top','via','inner1'],widthsMm:[.1],vias:1,route:[{x:0,y:0},{x:2,y:3}]}],settings:[]},
    runs:[{name:'A/B',rows:[[0,99,.2],[.17,88,5],[1,77,-.1]],
      probes:[{name:'RX,"voltage"',column:2,simulationVoltageProbeId:'p',signalSourceId:'rx',referenceSourceId:'gnd'}],
      eyes:[{name:'RX eye',simulationVoltageProbeId:'p',unitIntervalSeconds:.1,startTimeSeconds:0,endTimeSeconds:1,
        timeOriginSeconds:0,windows:1,metrics:{voltageRangeV:[-.1,5]},csv:eyeCsv}],
      test:{startTimeSeconds:0,durationSeconds:1,maxStepSeconds:.01,models:[],states:[],stimuli:[{
        type:'simulation_digital_stimulus',simulation_digital_stimulus_id:'s',name:'DATA',simulation_experiment_id:'e',
        source_port_id:'tx',unit_interval_ms:100,start_time_ms:0,initial_state:0,inverted:true,
        pattern:{type:'bits',bits:'0011',repeat:true},
      }]}}, {name:'A?B',rows:[[0,1],[1,2]],probes:[{name:'RX',column:1}],eyes:[]}],limitations:['Finite observations']}
  await writeViewerData(join(directory,'results.html'),data)
  const html=await readFile(join(directory,'results.html'),'utf8')
  assert.ok(html.indexOf('id="traces"')<html.indexOf('id="tests"')&&html.indexOf('id="tests"')<html.indexOf('id="results"'))
  assert.match(html,/U1.M3 → U3.E3/)
  assert.match(html,/U3.E3 − U3.B1/)
  assert.match(html,/45.25 mm/)
  assert.match(html,/Trace &lt;DQ&gt; test/)
  assert.match(html,/no pass\/fail thresholds/)
  assert.equal(await readFile(join(directory,'csv/01-a-b-waveforms.csv'),'utf8'),
    '"time_s","RX,""voltage""_v"\n0,0.2\n0.17,5\n1,-0.1\n','noncontiguous source columns are mapped without loss or rounding')
  assert.equal(await readFile(join(directory,'csv/02-a-b-waveforms.csv'),'utf8'),'"time_s","RX_v"\n0,1\n1,2\n','colliding display names keep separate files')
  assert.equal(await readFile(join(directory,'csv/01-a-b-eye-1.csv'),'utf8'),eyeCsv)
  assert.match(await readFile(join(directory,'csv/results-summary.csv'),'utf8'),/,3,0,1,-0.1,5\n/)
  assert.match(await readFile(join(directory,'csv/trace-map.csv'),'utf8'),/"source_trace_14","route14",45.25/)
  assert.match(await readFile(join(directory,'csv/test-plan.csv'),'utf8'),/"0011","true","true",0,0.1,0,0,1,0.01/)
  const embedded=JSON.parse(html.match(/id="simulation-data">([\s\S]*?)<\/script>/)![1])
  assert.deepEqual(embedded.runs[0].rows,data.runs[0].rows)
  assert.equal(embedded.runs[0].probes[0].signalLabel,'U3.E3')
  assert.equal(embedded.runs[0].eyes[0].csv,undefined,'folded samples are saved once outside the HTML')
})

test('board context keeps unused routing and highlights only simulated physical components',async()=>{
  const circuit: CircuitJson=JSON.parse(await readFile(new URL('../../../am3352.circuit.json',import.meta.url),'utf8'))
  const modeling: Modeling=JSON.parse(await readFile(new URL('./fixtures/am3352.modeling.json',import.meta.url),'utf8'))
  const geometry=geometryFromCircuitJson(circuit,modeling),context=reportContext(circuit,geometry,modeling),board=context.board!
  assert.equal(board.traces.length,circuit.filter(e=>e.type==='pcb_trace').length)
  assert.equal(board.components.length,circuit.filter(e=>e.type==='pcb_component'&&e.do_not_place!==true).length)
  assert.deepEqual(board.components.filter(component=>component.used).map(component=>component.name).sort(),['U1','U3'])
  assert.ok(board.components.some(component=>!component.used&&component.name.startsWith('R')))
  assert.ok(board.traces.some(trace=>!geometry.mappings.some(lane=>lane.pcbTraceId===trace.id)))
  for(const lane of geometry.mappings)assert.ok(board.traces.some(trace=>trace.id===lane.pcbTraceId))
  assert.ok(board.bounds.minX<=-50&&board.bounds.maxX>=50&&board.bounds.minY<=-40&&board.bounds.maxY>=40)
})
