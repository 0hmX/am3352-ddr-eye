import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {runtimePaths} from '../src/runtime.mjs'
import {parseFastHenry} from '../src/matrices.mjs'

// Actual routed reference-mesh pair whose old endpoint-square formula lost 2.44%.
const a=[[.00290779196,-.01846599267,-.0000175],[.00241202172,-.01840108644,-.0000175]]
const b=[[.001916252615,-.018336179954999997,0],[.00241202172,-.01840108644,0]]
// Independently evaluated oriented Neumann line integral at 90-digit precision.
const reference=-6.758773831804921e-11
const fixtures=[
  {a,b,reference,width:1e-9},
  // A positive vertical gap makes this shallow crossing disjoint. The old
  // cosine/EPS parallel shortcut underestimated this line integral by 5.55%.
  {a:[[0,0,0],[.001,0,0]],b:[[0,-.5e-10,1e-12],[.001,.5e-10,1e-12]],reference:3.494634824444214e-9,width:1e-15},
]

test('executed FastHenry near-parallel kernel matches the independent line integral, reciprocity and orientation',async()=>{
  const {tools}=await runtimePaths({projectDir:fileURLToPath(new URL('../../..',import.meta.url))})
  for(const {a,b,reference,width} of fixtures) for(const [first,second,expected] of [[a,b,reference],[a,[...b].reverse(),-reference],[b,a,reference]]) {
    const dir=await mkdtemp(join(tmpdir(),'fh-near-parallel-'))
    try {
      const lines=['Captured PCB near-parallel line-kernel regression','.units m','.default sigma=58000000 nwinc=1 nhinc=1']
      for(const [i,endpoints] of [first,second].entries()) {
        for(const [j,[x,y,z]] of endpoints.entries()) lines.push(`N${i}_${j} x=${x} y=${y} z=${z}`)
        // Tiny cross sections select the centerline branch. This checks the native
        // line kernel, without asserting finite-width parent-prism accuracy.
        lines.push(`E${i} N${i}_0 N${i}_1 w=${width} h=${width}`,`.external N${i}_0 N${i}_1`)
      }
      lines.push('.freq fmin=100000000 fmax=100000000 ndec=1','.end')
      await writeFile(join(dir,'pair.inp'),lines.join('\n')+'\n')
      const result=await promisify(execFile)(tools.fasthenry,['pair.inp','-s','ludecomp','-m','direct','-p','off','-a','off'],{cwd:dir,timeout:30000})
      assert.doesNotMatch(result.stdout+result.stderr,/convergence not reached|distance d between filaments is negative|near.parallel.*fail|\bnan\b/i)
      const matrices=parseFastHenry(await readFile(join(dir,'Zc.mat'),'utf8'))
      assert.equal(matrices.length,1)
      const {frequencyHz,L}=matrices[0]
      assert.equal(frequencyHz,100e6)
      assert.equal(L.length,2)
      // Zc.mat prints about six significant digits: 2e-5 allows rounding while
      // remaining over 1,000 times tighter than the original failing result.
      for(const actual of [L[0][1],L[1][0]]) assert.ok(Math.abs(actual/expected-1)<2e-5,`${actual}H versus independent ${expected}H`)
      assert.ok(Math.abs((L[0][1]-L[1][0])/expected)<2e-5,'reciprocity')
    } finally {await rm(dir,{recursive:true,force:true})}
  }
})
