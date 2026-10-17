import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { viewerClient } from './viewer-client.js'
import { html as escapeHtml, reportContext, reportFiles, reportSections, type ReportData, type ReportChange } from './report.js'
import type { CircuitJson } from './schema.js'
import type { Geometry, Modeling } from './geometry.js'

export interface ViewerRun {
  name: string; directory: string
  probes: { name: string; simulationVoltageProbeId: string; column: number }[]
  eyes: { name: string; simulationVoltageProbeId: string; unitIntervalSeconds: number; windowOriginsSeconds?: number[]; directory?: string }[]
}
export async function writeViewer(root: string, runs: ViewerRun[], limitations: string[], changes?: ReportChange[]) {
  const load = async (path: string) => JSON.parse(await readFile(join(root, path), 'utf8'))
  const data = { runs: await Promise.all(runs.map(async run => ({ ...run,
    test: await load(join(run.directory, 'experiment.json')),
    eyes: await Promise.all(run.eyes.map(async eye => ({ ...eye,
      csv: eye.directory ? await readFile(join(root, run.directory, eye.directory, 'eye-data.csv'), 'utf8') : undefined,
    }))),
    rows: (await readFile(join(root, run.directory, 'waveform.csv'), 'utf8')).trim().split(/\r?\n/).slice(1).map(line => line.split(',').map(Number)),
  }))), limitations, changes, context: reportContext(await load('inputs/circuit.json') as CircuitJson,
    await load('geometry.json') as Geometry, await load('inputs/modeling.json') as Modeling) }
  return writeViewerData(join(root, 'results.html'), data)
}
export async function writeViewerData(path: string, data: ReportData, title = 'Signal integrity report') {
  const files = reportFiles(data), sections = reportSections(data, files)
  await mkdir(join(dirname(path), 'csv'), { recursive: true })
  for (const file of files) await writeFile(join(dirname(path), file.path), file.content)
  const { context, ...viewerData } = data
  const payload = JSON.stringify({ ...viewerData, runs: data.runs.map(({ test, ...run }) => ({ ...run,
    probes: run.probes.map(probe => context ? { ...probe, signalLabel: context.ports[probe.signalSourceId ?? ''] ?? probe.signalSourceId,
      referenceLabel: probe.referenceSourceId ? context.ports[probe.referenceSourceId] ?? probe.referenceSourceId : 'Channel ground' } : probe),
    eyes: run.eyes.map(({ csv, ...eye }) => eye),
  })) }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  await writeFile(path, `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title>
<style>
[hidden]{display:none!important}*{box-sizing:border-box}body{margin:0;color:#202b38;background:#fff;font:13px system-ui,-apple-system,sans-serif;line-height:1.5}main{max-width:1480px;margin:auto;padding:0 28px}h1{font-size:18px;letter-spacing:-.025em;margin:0;font-weight:650}h2{font-size:14px;margin:0 0 10px;font-weight:650}h3{font-size:13px;margin:0 0 6px}p{margin:8px 0;color:#697586}a{color:#245eb5;text-decoration:none}a:hover{text-decoration:underline}
.app-header{display:flex;align-items:center;gap:18px;padding:20px 0 12px}.app-mark{font-size:11px;color:#6c7989;border-right:1px solid #dce2e9;padding-right:18px}.status{margin-left:auto;font-size:12px;color:#2a7155}#summary{font-size:12px;color:#6c7989;margin-bottom:16px}
nav{display:flex;gap:24px;border-bottom:1px solid #dce2e9;overflow:auto}nav button{border:0;border-bottom:2px solid transparent;border-radius:0;padding:10px 0;background:none;color:#77818e;white-space:nowrap}nav button[aria-selected=true]{border-bottom-color:#245eb5;color:#1c3557;font-weight:650}.panel{padding:20px 0;min-width:0}
button,select,input,.download{font:inherit;border:1px solid #d4dce6;border-radius:4px;padding:6px 10px;color:#334155;background:#fff}button,a{cursor:pointer}button:hover{background:#f5f7fa}button[aria-pressed=true]{background:#edf3ff;border-color:#a9bfe8;color:#245eb5}button:disabled{opacity:.4;cursor:default}button:focus-visible,a:focus-visible,select:focus-visible,input:focus-visible{outline:2px solid #769fe7;outline-offset:2px}
.board-layout{display:grid;grid-template-columns:minmax(0,1fr) 290px;gap:28px}.board-toolbar{font-size:11px;color:#7a8493;margin-bottom:8px}.route-map{min-width:0}.route-map svg{display:block;width:100%;height:590px;background:#fafbfd;border:1px solid #e5e9ef}.board-legend{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;margin-top:12px}.component-key{color:#4567ac}.unused-key{color:#84909e}
.board-outline rect,.board-outline path{fill:#fff;stroke:#b4bfce;stroke-width:1.5}.unused-components rect{fill:#f2f4f7;stroke:#c2cbd6;stroke-width:.7}.unused-traces path{fill:none;stroke:#c2cbd6;stroke-opacity:.7;stroke-width:.7}.used-components rect{fill:#dce8ff;fill-opacity:.75;stroke:#4567ac;stroke-width:1.8}.used-traces path{fill:none;stroke-width:2.6}.used-traces circle{stroke-width:1.5}.route-map path,.route-map rect,.route-map circle{vector-effect:non-scaling-stroke}.component-labels{text-anchor:middle;fill:#243f70;stroke:#fff;stroke-width:.2;paint-order:stroke;font-weight:750;pointer-events:none}
.trace-inspector{border-left:1px solid #e5e9ef;padding-left:24px}.trace-row{padding:14px 0;border-bottom:1px solid #e5e9ef}.trace-row small{float:right;font-size:11px;color:#7a8493;font-weight:400}.pin-pair{font:11px ui-monospace,monospace;color:#536277;margin-bottom:10px}dl{display:grid;grid-template-columns:1fr auto;margin:0 0 8px;font-size:12px}dt{color:#7a8493}dd{margin:0;font-variant-numeric:tabular-nums}.hint{font-size:11px;color:#7a8493}
.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px;margin:10px 0 18px}th,td{text-align:left;padding:9px 12px;border-bottom:1px solid #e5e9ef;vertical-align:top;overflow-wrap:anywhere}th{font-weight:500;color:#7a8493;background:#f8fafc}td{min-width:85px;max-width:400px}th:first-child,td:first-child{padding-left:0}.trace-inspector td{font-size:10px;min-width:50px}details{margin-top:8px}summary{cursor:pointer;color:#637389;font-size:12px;padding:7px 0}pre{white-space:pre-wrap;font:12px/1.7 ui-monospace,monospace;color:#637389}
.test-card,.result-card{padding:0 0 20px;margin-bottom:20px;border-bottom:1px solid #e5e9ef}.test-card:last-child,.result-card:last-child{border-bottom:0}.result-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:8px}.result-heading button{font-size:11px}.comparison-summary{margin-bottom:24px}.comparison-summary table{background:#fbfcfe}
.toolbar{display:flex;align-items:end;gap:16px;flex-wrap:wrap}label{display:flex;flex-direction:column;gap:5px;font-size:11px;color:#6c7989}select{min-width:150px;max-width:100%}.check{flex-direction:row;align-items:center;padding-bottom:7px}.check input{margin:0}.grow{flex:1}.title{font-size:14px;font-weight:650;margin-top:20px}.binding{font-size:11px;color:#7a8493;margin-top:4px;overflow-wrap:anywhere}#legend{display:flex;gap:18px;flex-wrap:wrap;font-size:11px;margin:12px 0}canvas{display:block;width:100%;height:400px;touch-action:none;cursor:crosshair}#cursor{font:11px ui-monospace,monospace;min-height:20px;color:#637389}footer{display:flex;align-items:end;gap:14px;flex-wrap:wrap;border-top:1px solid #e5e9ef;padding-top:14px;margin-top:10px}input[type=number]{width:110px}.download{font-size:12px}#sample-count{font-size:11px;color:#7a8493;padding-bottom:7px}
@media(max-width:900px){.board-layout{grid-template-columns:minmax(0,1fr) 240px;gap:16px}.trace-inspector{padding-left:16px}.route-map svg{height:520px}}@media(max-width:700px){main{padding:0 16px}.app-header{gap:12px}.app-mark{display:none}h1{font-size:16px}nav{gap:22px}.board-layout{grid-template-columns:1fr}.trace-inspector{border-left:0;padding:0}.route-map svg{height:380px}.trace-row{padding:12px 0}.panel{padding-top:16px}canvas{height:330px}th,td{padding:8px}footer{gap:10px}.status{font-size:11px}}
</style></head><body><main>
<header class="app-header"><span class="app-mark">SIMULATION</span><h1>${escapeHtml(title.replace(/\s+report$/i, ''))}</h1><span class="status">● Complete</span></header><div id="summary"></div>
<nav role="tablist" aria-label="Simulation views">${[['traces','Board'],['tests','Tests'],['results','Results'],['explore','Plots'],['downloads','CSV files'],['assumptions','Model']].map(([id,label],i)=>`<button id="tab-${id}" role="tab" data-tab="${id}" aria-controls="${id}" aria-selected="${i===0}" tabindex="${i===0?0:-1}">${label}</button>`).join('')}</nav>
<section class="panel" id="traces" role="tabpanel" aria-labelledby="tab-traces">${sections.traces}</section>
<section class="panel" id="tests" role="tabpanel" aria-labelledby="tab-tests" hidden>${sections.plan}<p class="hint">Drive bits include stimulus inversion.</p></section>
<section class="panel" id="results" role="tabpanel" aria-labelledby="tab-results" hidden>${sections.findings}<p class="hint">Min/max use the full recording. Eye ranges use their declared gates.</p></section>
<section class="panel" id="explore" role="tabpanel" aria-labelledby="tab-explore" aria-label="Interactive simulation results" hidden><div class="toolbar"><label>Experiment<select id="run"></select></label><label>Probe<select id="probe"></select></label><label class="check"><input id="overlay" type="checkbox">Overlay runs</label><span class="grow"></span><button id="waveform-button" aria-pressed="true">Waveform</button><button id="eye-button" aria-pressed="false">Eye</button></div><div class="title" id="selection"></div><div class="binding" id="binding"></div><div id="legend"></div><label id="eye-field" hidden>Eye<select id="eye"></select></label><canvas id="plot" role="img" aria-label="Voltage plot: scroll to zoom, drag to pan, double click to reset"></canvas><div id="cursor" aria-live="off"></div><footer><label>Start (ns)<input id="start" type="number" step="any"></label><label>End (ns)<input id="end" type="number" step="any"></label><button id="reset">Reset</button><span class="grow"></span><span id="sample-count"></span><a id="csv" href="#" class="download" download>Download CSV</a></footer><p class="hint">Scroll to zoom · drag to pan · double-click to reset.</p></section>
<section class="panel" id="downloads" role="tabpanel" aria-labelledby="tab-downloads" hidden>${sections.downloads}</section>
<section class="panel" id="assumptions" role="tabpanel" aria-labelledby="tab-assumptions" hidden><p>${escapeHtml(data.context?.description ?? '')}</p>${sections.settings}<details open><summary>Assumptions</summary><pre id="limitations">${escapeHtml(data.limitations.join('\n'))}</pre></details><p class="hint">Observed values only; no pass/fail thresholds or compliance assessment. Waveform CSVs retain every solver sample. Eye CSVs use linear interpolation. Plot display envelopes preserve extrema.</p></section>
</main><noscript><style>[role=tabpanel][hidden]{display:block!important}</style></noscript><script type="application/json" id="simulation-data">${payload}</script><script>(${viewerClient.toString()})();</script></body></html>`)
  return path
}
