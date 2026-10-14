#!/usr/bin/env python3
"""Rebuild the local browser dependency; ordinary tsci dev/build stay unchanged."""
import base64
import argparse
import gzip
import hashlib
import io
import json
import re
import shutil
import subprocess
import tarfile
import uuid
from pathlib import Path

here = Path(__file__).resolve().parent
project = here.parents[1]
manifest = json.loads((here / 'provenance.json').read_text())
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--refresh', action='store_true', help='Update the dependency lock and expected hashes after intentional source changes')
refresh = parser.parse_args().refresh
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
if refresh:
    lock = source / 'pnpm-lock.yaml'
    pattern = re.compile(r'(resolution:\s*\{integrity:\s*)sha512-[A-Za-z0-9+/=]+(,\s*tarball:\s*file:([^}\s]+)\s*\})')
    def refresh_integrity(match):
        archive = (source / match[3]).resolve()
        if archive.parent != project / '.packages':
            raise RuntimeError('Unexpected local dependency archive')
        digest = base64.b64encode(hashlib.sha512(archive.read_bytes()).digest()).decode()
        return match[1] + 'sha512-' + digest + match[2]
    lock.write_text(pattern.sub(refresh_integrity, lock.read_text()))
run('pnpm', 'install', '--no-frozen-lockfile' if refresh else '--frozen-lockfile', cwd=source)
for name, filename in [('core', 'tscircuit-core-ibis-experimental.tgz'), ('props', 'tscircuit-props-ibis-experimental.tgz'), ('ibis-to-spice', 'ibis-to-spice-0.0.2.tgz'), ('circuit-json', 'circuit-json-general-experimental.tgz')]:
    installed = source / 'node_modules' / (name if name == 'circuit-json' else '@tscircuit/' + name)
    with tarfile.open(project / '.packages' / filename) as archive:
        for member in archive.getmembers():
            if member.isfile():
                path = installed / Path(member.name).relative_to('package')
                if path.read_bytes() != archive.extractfile(member).read():
                    raise RuntimeError('Installed dependency differs from archive: ' + str(path))
if refresh:
    shutil.copyfile(source / 'pnpm-lock.yaml', here / 'pnpm-lock.yaml')
run('pnpm', 'exec', 'tsup', '--config', 'tsup-webworker.config.ts', cwd=source)
new_worker = (source / 'dist/webworker/entrypoint.js').read_bytes()
worker_hash = hashlib.sha256(new_worker).hexdigest()
if refresh:
    manifest['eval']['workerSha256'] = worker_hash
if worker_hash != manifest['eval']['workerSha256']:
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
if refresh:
    runtime_manifest = json.loads((here / 'runtime-manifest.json').read_text())
    runtime_manifest['eval']['workerSha256'] = worker_hash
    for key, filename in [('corePackageSha256', 'tscircuit-core-ibis-experimental.tgz'), ('propsPackageSha256', 'tscircuit-props-ibis-experimental.tgz'), ('converterPackageSha256', 'ibis-to-spice-0.0.2.tgz'), ('circuitJsonPackageSha256', 'circuit-json-general-experimental.tgz')]:
        runtime_manifest[key] = hashlib.sha256((project / '.packages' / filename).read_bytes()).hexdigest()
    (here / 'runtime-manifest.json').write_text(json.dumps(runtime_manifest, indent=2) + '\n')
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
if refresh:
    manifest['outputSha256'] = actual
    manifest['outputBytes'] = output.stat().st_size
    manifest['dependencyLockSha256'] = hashlib.sha256((here / 'pnpm-lock.yaml').read_bytes()).hexdigest()
    for key, filename in [('corePackageSha256', 'tscircuit-core-ibis-experimental.tgz'), ('propsPackageSha256', 'tscircuit-props-ibis-experimental.tgz'), ('converterPackageSha256', 'ibis-to-spice-0.0.2.tgz'), ('circuitJsonPackageSha256', 'circuit-json-general-experimental.tgz')]:
        manifest[key] = hashlib.sha256((project / '.packages' / filename).read_bytes()).hexdigest()
    (here / 'provenance.json').write_text(json.dumps(manifest, indent=2) + '\n')
if actual != manifest['outputSha256']:
    raise RuntimeError('Rebuilt package differs from the tested package: ' + actual)
print(output)
print(actual)
