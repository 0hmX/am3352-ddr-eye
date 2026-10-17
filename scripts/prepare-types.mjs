// fanout-solver publishes TypeScript source as its "types" entry. Emit its
// declarations locally so consumers do not typecheck third-party implementation
// under this project's strict settings. Runtime dependencies stay unmodified.
import ts from 'typescript'
import {createRequire} from 'node:module'
import {dirname,join,relative,resolve} from 'node:path'
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs'
const require=createRequire(import.meta.resolve('@tscircuit/core'))
const manifest=require.resolve.paths('@tscircuit/fanout-solver').map(path=>join(path,'@tscircuit/fanout-solver/package.json')).find(existsSync)
if(!manifest) throw new Error('Install the published tscircuit dependencies first')
const entry=join(dirname(manifest),JSON.parse(readFileSync(manifest,'utf8')).exports['.'].types),root=dirname(entry)
const output=resolve('node_modules/.cache/tscircuit-declarations/fanout')
const program=ts.createProgram([entry],{declaration:true,emitDeclarationOnly:true,noCheck:true,
  target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,skipLibCheck:true})
for(const source of program.getSourceFiles()) if(!source.isDeclarationFile&&source.fileName.startsWith(root+'/')) {
  const path=join(output,relative(root,source.fileName).replace(/\.tsx?$/,'.d.ts'))
  program.emit(source,(_name,text)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text)},undefined,true)
}
