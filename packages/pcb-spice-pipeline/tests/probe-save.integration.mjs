import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {runtimePaths} from '../src/runtime.mjs'
import {generalSimulationSpice} from '../src/general-spice.mjs'
import {probeWaveformRows} from '../src/metrics.mjs'

test('saving only declared probe terminals preserves native waveforms and timestamps while excluding internal channel vectors',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'probe-save-'))
  try {
    const {tools}=await runtimePaths({projectDir:fileURLToPath(new URL('../../..',import.meta.url))})
    const plan={experiment:{},maxStepSeconds:2e-11,durationSeconds:8e-9,startTimeSeconds:0,probes:[
      {name:'differential',signalNode:'rx',referenceNode:'ref'},
      {name:'transmit',signalNode:'tx',referenceNode:'0'},
      {name:'reference',signalNode:'ref',referenceNode:'0'},
      {name:'across-channel',signalNode:'tx',referenceNode:'rx'},
    ]}
    const electrical={lines:['VDRIVE tx 0 PULSE(0 1.5 0 80p 80p 900p 2n)','VREF ref 0 SIN(.15 .03 40meg)','RLOAD rx 0 80'],activeNodes:new Set(['0','tx','ref','rx']),grounded:new Set(['0','ref'])}
    const geometry={mappings:[{from:'tx',to:'rx'}]},nodes={node:id=>id}
    const deck=generalSimulationSpice(plan,geometry,{sections:4},[{R:[[2]],L:[[2e-8]],C:[[2e-12]]}],[],nodes,electrical)
    assert.match(deck,/^save v\(rx\) v\(ref\) v\(tx\)\ntran /m,'save both terminals, deduplicate them and omit ground before solving')
    const runs=[]
    for(const [name,source] of [['selected',deck],['default',deck.replace(/^save .*\n/m,'')]]) {
      const cwd=join(dir,name)
      await mkdir(cwd)
      await writeFile(join(cwd,'circuit.cir'),source.replace('quit\n','set filetype=ascii\nwrite vectors.raw all\nquit\n'))
      const result=await promisify(execFile)(tools.ngspice,['-b','circuit.cir'],{cwd,timeout:30000})
      assert.doesNotMatch(result.stdout+result.stderr,/fatal error|unknown vector|no such vector/i)
      runs.push({waveform:await readFile(join(cwd,'waveform.dat'),'utf8'),raw:await readFile(join(cwd,'vectors.raw'),'utf8')})
    }
    assert.equal(runs[0].waveform,runs[1].waveform,'probe values and every adaptive timestamp are byte-identical')
    const rows=probeWaveformRows(runs[0].waveform,plan.probes)
    assert.ok(rows.length>400,'native transient has adaptive waveform samples')
    for(const row of rows) {
      assert.ok(Math.abs(row[1]-(row[2]-row[4])+row[3])<1e-12,'differential probe retains its varying reference')
      assert.ok(Math.abs(row[3]-(.15+.03*Math.sin(2*Math.PI*40e6*row[0])))<1e-12,'reference waveform is retained')
    }
    const vectorCount=run=>Number(run.raw.match(/^No\. Variables:\s*(\d+)/m)[1])
    assert.equal(vectorCount(runs[0]),1+3+plan.probes.length,'only time, three terminals and declared derived probes are retained')
    assert.ok(vectorCount(runs[1])>vectorCount(runs[0])+10,'default run also retains internal ladder vectors')
    assert.doesNotMatch(runs[0].raw.split('Values:')[0],/v\(xchan\./)
    assert.match(runs[1].raw.split('Values:')[0],/v\(xchan\./)
  } finally {await rm(dir,{recursive:true,force:true})}
})
