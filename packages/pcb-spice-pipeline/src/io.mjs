import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {createWriteStream} from 'node:fs'
import {finished} from 'node:stream/promises'
import {unzipSync} from 'fflate'
import {fail} from './matrices.mjs'
const exec=promisify(execFile)
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex')
export const json=(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n')
export async function command(executable,args,cwd,label) {
  const timeoutMs=Number(process.env.PCB_SPICE_TIMEOUT_MS??900000)
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0) fail('native_timeout','PCB_SPICE_TIMEOUT_MS must be a positive integer in milliseconds')
  const threads=Number(process.env.PCB_SPICE_THREADS??1)
  if(!Number.isSafeInteger(threads)||threads<1||threads>32) fail('native_threads','PCB_SPICE_THREADS must be an integer 1..32')
  const start=Date.now();let result
  const pending=exec(executable,args,{cwd,timeout:timeoutMs,maxBuffer:64*1024*1024,env:{...process.env,OMP_NUM_THREADS:String(threads)}})
  const streams=['stdout','stderr'].map(kind=>{
    const stream=createWriteStream(join(cwd,`${label}.${kind}.log`))
    pending.child[kind].on('data',data=>stream.write(data))
    return stream
  })
  try {const r=await pending;result={exitCode:0,stdout:r.stdout,stderr:r.stderr}}
  catch(e) {result={exitCode:e.code??null,signal:e.signal??null,killed:e.killed??false,stdout:e.stdout??'',stderr:e.stderr??e.message}}
  for(const stream of streams) stream.end()
  await Promise.all(streams.map(stream=>finished(stream)))
  const record={executable,args,cwd,exitCode:result.exitCode,signal:result.signal??null,elapsedMs:Date.now()-start,timeoutMs,environment:{OMP_NUM_THREADS:String(threads)}}
  await json(join(cwd,`${label}.command.json`),record)
  if(result.exitCode!==0) fail('native_solver',`${label} ${result.signal??`exited ${result.exitCode}`} after ${record.elapsedMs}ms (limit ${timeoutMs}ms); see ${cwd}/${label}.stderr.log`)
  return {...result,record}
}
export async function vendorSource(lock,cache) {
  await mkdir(cache,{recursive:true});const ibs=join(cache,`${lock.sha256}.ibs`),zip=join(cache,`${lock.archiveSha256}.zip`)
  let bytes,archive
  try {archive=await readFile(zip)} catch {const response=await fetch(lock.url);if(!response.ok) fail('vendor_download',`${lock.vendor}: HTTP ${response.status}`);archive=Buffer.from(await response.arrayBuffer());if(sha256(archive)!==lock.archiveSha256) fail('vendor_hash',`${lock.vendor}: archive changed`);await writeFile(zip,archive)}
  if(sha256(archive)!==lock.archiveSha256) fail('vendor_hash',`${lock.vendor}: cached archive corrupt`)
  bytes=unzipSync(archive)[lock.archivePath]
  if(!bytes||sha256(bytes)!==lock.sha256) fail('vendor_hash',`${lock.vendor}: original IBIS bytes do not match lock`)
  await writeFile(ibs,bytes)
  return {bytes:Buffer.from(bytes),text:Buffer.from(bytes).toString('utf8'),archive,lock}
}
export async function hashes(root,relative='',excludedRootNames=[]) {
  const out={}
  for(const name of (await readdir(join(root,relative))).sort()) {
    if((!relative&&excludedRootNames.includes(name))||name==='__pycache__'||name==='node_modules') continue
    const p=join(relative,name),s=await stat(join(root,p))
    if(s.isDirectory()) Object.assign(out,await hashes(root,p,excludedRootNames))
    else if(p!=='receipt.json') out[p]=sha256(await readFile(join(root,p)))
  }
  return out
}
