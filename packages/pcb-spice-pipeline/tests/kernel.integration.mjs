import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {runtimePaths} from '../src/runtime.mjs'
import {parseFastHenry,parseFasterCap,validateMatrix} from '../src/matrices.mjs'

const exec=promisify(execFile)
const header=fileURLToPath(new URL('../scripts/fh-far-mutual.h',import.meta.url))

test('executed capacitance triangle formula agrees with a 70-digit independent integral, including the failing board panel',async()=>{
  const {tools,python}=await runtimePaths({projectDir:fileURLToPath(new URL('../../..',import.meta.url))})
  const source=fileURLToPath(new URL('../source/',`file://${tools.fastercap}`))
  const check=fileURLToPath(new URL('./fastercap-kernel.py',import.meta.url))
  const result=await exec(python,[check,source])
  const comparison=JSON.parse(result.stdout)
  assert.equal(comparison.relativeErrors.length,4)
})

// Independent composite Simpson integration of the oriented Neumann integral.
function reference({a,da,b,db}) {
  const n=256,h=1/n,dot=da.reduce((s,v,k)=>s+v*db[k],0)
  let sum=0
  for(let i=0;i<=n;i++) for(let j=0;j<=n;j++) {
    const distance=Math.hypot(...a.map((v,k)=>(v-b[k])+i*h*da[k]-j*h*db[k]))
    const wi=i===0||i===n?1:i%2?4:2,wj=j===0||j===n?1:j%2?4:2
    sum+=wi*wj/distance
  }
  return 1e-7*dot*sum*h*h/9
}

test('compiled far-filament kernel agrees with independent quadrature and preserves reciprocity and orientation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fh-kernel-'))
  try {
    await writeFile(join(dir,'test.c'),`#include <math.h>
#include <stdlib.h>
#include <stdio.h>
#include "${header}"
int main(int argc,char**argv) {
  double q[12];int i;
  if(argc!=13)return 1;
  for(i=0;i<12;i++)q[i]=strtod(argv[i+1],0);
  printf("%.17g\\n",fh_far_mutual(q,q+3,q+6,q+9));return 0;
}`)
    const binary=join(dir,'kernel')
    await exec('cc',['-O2',join(dir,'test.c'),'-lm','-o',binary])
    const fixtures=[
      {a:[0,0,0],da:[1e-5,0,0],b:[0,8.6e-4,0],db:[1e-5,0,0]},
      {a:[.02,-.03,.001],da:[1e-4,2e-5,3e-5],b:[.021,-.031,.0015],db:[-8e-5,3e-5,2e-5]},
      {a:[0,0,0],da:[.001,0,0],b:[0,.0041,0],db:[.001,0,0]},
    ]
    for(const fixture of fixtures) {
      const {a,da,b,db}=fixture
      const run=async q=>Number((await exec(binary,Object.values(q).flat().map(String))).stdout)
      const actual=await run(fixture),expected=reference(fixture)
      assert.ok(Math.abs(actual/expected-1)<1e-10,`${actual} versus ${expected}`)
      assert.ok(Math.abs((await run({b,db,a,da}))/actual-1)<1e-13,'reciprocity')
      assert.ok(Math.abs((await run({a,da,b:b.map((v,k)=>v+db[k]),db:db.map(v=>-v)}))/actual+1)<1e-13,'orientation reversal')
    }
  } finally {await rm(dir,{recursive:true,force:true})}
})

test('meshed return matches analytic DC resistance; iterative impedance matches an independent dense solve',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fh-sheet-'))
  try {
    const {tools}=await runtimePaths({projectDir:fileURLToPath(new URL('../../..',import.meta.url))})
    const sigma=58e6,thickness=.000035,step=.001,lines=['Sheet calibration','.units m',`.default sigma=${sigma} nwinc=1 nhinc=1`]
    for(let x=0;x<=4;x++) for(let y=0;y<=3;y++) lines.push(`N${x}_${y} x=${x*step} y=${y*step} z=0`)
    let edge=0
    for(let x=0;x<=4;x++) for(let y=0;y<=3;y++) {
      if(x<4) lines.push(`E${edge++} N${x}_${y} N${x+1}_${y} w=${step*(y===0||y===3?.5:1)} h=${thickness} wx=0 wy=1 wz=0`)
      if(y<3) lines.push(`E${edge++} N${x}_${y} N${x}_${y+1} w=${step*(x===0||x===4?.5:1)} h=${thickness} wx=1 wy=0 wz=0`)
    }
    for(let y=1;y<=3;y++) lines.push(`.equiv N0_0 N0_${y}`,`.equiv N4_0 N4_${y}`)
    for(let i=0;i<2;i++) lines.push(`NS${i} x=0 y=${(i+1)*step} z=.0002`,`NE${i} x=.004 y=${(i+1)*step} z=.0002`,`ES${i} NS${i} NE${i} w=.0001 h=${thickness} wx=0 wy=1 wz=0`,`.equiv NE${i} N4_0`,`.external NS${i} N0_0`)
    lines.push('.freq fmin=100 fmax=100000000 ndec=1','.end')
    await writeFile(join(dir,'sheet.inp'),lines.join('\n')+'\n')
    await exec(tools.fasthenry,['sheet.inp','-s','ludecomp','-m','direct','-p','off','-S','dense'],{cwd:dir})
    await exec(tools.fasthenry,['sheet.inp','-o','4','-t','1e-7','-b','1e-9','-S','iterative'],{cwd:dir})
    const dense=parseFastHenry(await readFile(join(dir,'Zcdense.mat'),'utf8')),iterative=parseFastHenry(await readFile(join(dir,'Zciterative.mat'),'utf8'))
    const signalR=.004/(sigma*.0001*thickness),returnR=.004/(sigma*.003*thickness)
    for(let i=0;i<2;i++) for(let j=0;j<2;j++) assert.ok(Math.abs(dense[0].R[i][j]/(returnR+(i===j?signalR:0))-1)<.001,'analytic sheet return and signal resistance')
    for(let f=0;f<dense.length;f++) for(const kind of ['R','L']) {
      validateMatrix(dense[f][kind],`dense ${kind}`)
      const norm=Math.max(...dense[f][kind].flat().map(Math.abs))
      for(let i=0;i<2;i++) for(let j=0;j<2;j++) assert.ok(Math.abs(dense[f][kind][i][j]-iterative[f][kind][i][j])/norm<.002,'iterative versus dense matrix')
    }
  } finally {await rm(dir,{recursive:true,force:true})}
})

function sphereTriangles(depth) {
  let faces=[]
  for(const x of [-1,1]) for(const y of [-1,1]) for(const z of [-1,1]) faces.push([[x,0,0],[0,y,0],[0,0,z]])
  for(let level=0;level<depth;level++) faces=faces.flatMap(([a,b,c])=>{
    const middle=(u,v)=>{const sum=u.map((x,k)=>x+v[k]),norm=Math.hypot(...sum);return sum.map(x=>x/norm)}
    const ab=middle(a,b),bc=middle(b,c),ca=middle(c,a)
    return [[a,ab,ca],[ab,b,bc],[ca,bc,c],[ab,bc,ca]]
  })
  return faces
}

test('native capacitance calibration recovers the known isolated-sphere scale and reciprocal mutual coefficients',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'cap-sphere-'))
  try {
    const {tools}=await runtimePaths({projectDir:fileURLToPath(new URL('../../..',import.meta.url))})
    const radius=.001,epsilon=4.1,faces=sphereTriangles(3)
    for(const [i,label] of ['A','B'].entries()) {
      const triangles=faces.map(face=>`T ${label} `+face.flatMap(point=>point.map((x,k)=>x*radius+(k===0?i*.1:0))).join(' '))
      await writeFile(join(dir,`${label}.txt`),triangles.join('\n')+'\n')
    }
    await writeFile(join(dir,'spheres.lst'),`C A.txt ${epsilon} 0 0 0\nC B.txt ${epsilon} 0 0 0\n`)
    const result=await exec(tools.fastercap,['spheres.lst','-b','-a0.01','-d0.1'],{cwd:dir,timeout:120000,env:{...process.env,OMP_NUM_THREADS:'1'}})
    assert.doesNotMatch(result.stdout+result.stderr,/not converging|\bnan\b|zero conductor self-potential/i)
    const cap=parseFasterCap(result.stdout),checked=validateMatrix(cap.matrix,'sphere C')
    const expected=4*Math.PI*8.8541878128e-12*radius*epsilon
    for(let i=0;i<2;i++) assert.ok(Math.abs(checked.matrix[i][i]/expected-1)<.025,'polygonized sphere agrees with 4*pi*epsilon*r within 2.5%')
    assert.ok(cap.matrix[0][1]<0&&cap.matrix[1][0]<0,'negative Maxwell mutual coefficients')
  } finally {await rm(dir,{recursive:true,force:true})}
})
