import {readFile,access,realpath} from 'node:fs/promises'
import {dirname,join,resolve,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'

const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
export async function projectProvenance(entryPath,importedUrls=[],additionalPaths=[]) {
  let root=dirname(entryPath)
  while(true) {
    try {await access(join(root,'package.json'));break} catch {}
    const parent=dirname(root);if(parent===root) {root=dirname(entryPath);break} root=parent
  }
  root=await realpath(root)
  const paths=new Set([entryPath,...additionalPaths])
  for(const url of importedUrls) if(url.startsWith('file:')) paths.add(fileURLToPath(url))
  for(const file of ['package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','tscircuit.config.json']) {
    try {await access(join(root,file));paths.add(join(root,file))} catch {}
  }
  const files={},dependencyFiles={}
  for(const path of [...paths].sort()) {
    const absolute=await realpath(resolve(path)),key=relative(root,absolute)
    const bytes=await readFile(absolute)
    if(!isAbsolute(key)&&!key.startsWith('..')&&!key.split('/').includes('node_modules')) files[key]={path:absolute,sha256:hash(bytes)}
    else dependencyFiles[absolute]=hash(bytes)
  }
  return {root,entry:relative(root,await realpath(entryPath)),files,dependencyFiles,scope:'Exact entry, imported local modules/data, project manifests and executed dependency imports; fs-read original board is included explicitly'}
}
