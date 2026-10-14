#!/usr/bin/env python3
"""Rebuild the local browser dependency; ordinary tsci dev/build stay unchanged."""
import base64
import gzip
import hashlib
import io
import json
import shutil
import subprocess
import tarfile
import uuid
from pathlib import Path

here = Path(__file__).resolve().parent
project = here.parents[1]
manifest = json.loads((here / 'provenance.json').read_text())
nonce = uuid.uuid4().hex[:12]
artifacts = project / '.tscircuit' / ('browser-build-' + nonce)
artifacts.mkdir(parents=True)
source = project / '.tscircuit' / ('browser-eval-source-' + nonce)

def run(*args, cwd=None):
    subprocess.run(args, cwd=cwd, check=True)

def download(name):
    item = manifest['downloads'][name]
    path = artifacts / (name + '.tgz')
    run('curl', '--fail', '-LsS', item['url'], '-o', str(path))
    if hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
        raise RuntimeError('Unexpected source archive hash: ' + name)
    return path

def extract(path, directory):
    directory.mkdir(parents=True)
    with tarfile.open(path) as archive:
        archive.extractall(directory)

extract(download('evalSource'), artifacts / 'source')
shutil.move(str(next((artifacts / 'source').iterdir())), source)
run('git', 'apply', str(here / 'eval-local-proxy.patch'), cwd=source)
for file in ('package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'):
    shutil.copyfile(here / file, source / file)
run('pnpm', 'install', '--frozen-lockfile', cwd=source)
run('pnpm', 'exec', 'tsup', '--config', 'tsup-webworker.config.ts', cwd=source)
new_worker = (source / 'dist/webworker/entrypoint.js').read_bytes()
if hashlib.sha256(new_worker).hexdigest() != manifest['eval']['workerSha256']:
    raise RuntimeError('Rebuilt worker differs from the tested runtime')
extract(download('originalTscircuit'), artifacts / 'tscircuit')
extract(download('originalEval'), artifacts / 'eval')
package = artifacts / 'tscircuit/package'
old_worker = (artifacts / 'eval/package/dist/webworker/entrypoint.js').read_bytes()
browser = (package / 'dist/browser.min.js').read_text()
old_blob = base64.b64encode(old_worker).decode()
if browser.count(old_blob) != 1:
    raise RuntimeError('Expected exactly one embedded original eval worker')
(package / 'dist/browser.min.js').write_text(browser.replace(old_blob, base64.b64encode(new_worker).decode()))
(package / 'dist/webworker.min.js').write_bytes(new_worker)
shutil.copyfile(here / 'runtime-manifest.json', package / 'dist/experimental-runtime.json')
output = project / '.packages/tscircuit-experimental.tgz'
with output.open('wb') as destination:
    with gzip.GzipFile(fileobj=destination, mode='wb', mtime=0, filename='') as compressed:
        with tarfile.open(fileobj=compressed, mode='w') as archive:
            for path in sorted(package.rglob('*')):
                if not path.is_file():
                    continue
                info = archive.gettarinfo(str(path), str(Path('package') / path.relative_to(package)))
                info.mtime = info.uid = info.gid = 0
                info.uname = info.gname = ''
                with path.open('rb') as data:
                    archive.addfile(info, data)
actual = hashlib.sha256(output.read_bytes()).hexdigest()
if actual != manifest['outputSha256']:
    raise RuntimeError('Rebuilt package differs from the tested package: ' + actual)
print(output)
print(actual)
