import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {loadEntry,sha256} from '../src/pipeline.mjs'

test('plain Node loads TSX and fingerprints the actual imported project data',async()=>{
  const root=await mkdtemp(join(tmpdir(),'pcb-spice-input-'))
  try {
    await writeFile(join(root,'package.json'),' {"name":"input-proof","type":"module"}\n')
    const entry=join(root,'index.circuit.tsx')
    await writeFile(entry,"import data from './board.json' with { type: 'json' }\nconst name: string = 'board'\nexport const circuitJson = data\nexport const modeling = {}\nexport default () => null\n")
    const a='[{"type":"source_component","name":"first"}]\n'
    await writeFile(join(root,'board.json'),a)
    const first=await loadEntry(entry)
    assert.equal(first.circuitJson[0].name,'first')
    assert.equal(first.project.files['board.json'].sha256,sha256(a))
    assert.ok(first.project.files['index.circuit.tsx'])
    assert.ok(first.project.files['package.json'])
    assert.ok(Object.keys(first.project.dependencyFiles).some(path=>path.includes('ibis-to-spice')))
    const b='[{"type":"source_component","name":"second"}]\n'
    await writeFile(join(root,'board.json'),b)
    const second=await loadEntry(entry)
    assert.equal(second.circuitJson[0].name,'second','Changed imported bytes must be used, not a cached board')
    assert.equal(second.project.files['board.json'].sha256,sha256(b))
  } finally {await rm(root,{recursive:true,force:true})}
})

test('TSX transformation follows the entry project config when caller cwd is elsewhere',async()=>{
  const root=await mkdtemp(new URL('./jsx-project-',import.meta.url).pathname)
  try {
    await writeFile(join(root,'package.json'),'{"name":"jsx-input-proof","type":"module"}\n')
    await writeFile(join(root,'tsconfig.json'),'{"compilerOptions":{"jsx":"react-jsx","module":"ESNext"},"include":["index.circuit.tsx"]}\n')
    const entry=join(root,'index.circuit.tsx')
    await writeFile(entry,"const evaluated = <div />\nexport const circuitJson = []\nexport const modeling = {}\nexport default () => evaluated\n")
    const result=await loadEntry(entry)
    assert.deepEqual(result.circuitJson,[])
    assert.ok(result.project.files['tsconfig.json'])
  } finally {await rm(root,{recursive:true,force:true})}
})
