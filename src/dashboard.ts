import { createServer, type Server } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

type JsonRecord = Record<string, unknown>;

export interface DashboardStats {
  generated_at: string;
  source: {
    root: string;
    decisions: string;
    plans: string;
    parse_errors: number;
  };
  decisions: {
    total: number;
    by_status: Record<string, number>;
    by_source: Record<string, number>;
    by_provider: Record<string, number>;
    avg_elapsed_ms: number | null;
    p50_elapsed_ms: number | null;
    p95_elapsed_ms: number | null;
    selected_capabilities: Array<{ id: string; count: number }>;
    latest: Array<{
      decision_id: string;
      status: string;
      selected: string | null;
      provider: string | null;
      source: string | null;
      elapsed_ms: number | null;
      recorded_at: string;
    }>;
  };
  plans: {
    total: number;
    by_mode: Record<string, number>;
    steps: number;
    by_status: Record<string, number>;
  };
  execution: {
    not_started: number;
    started: number;
    succeeded: number;
    failed: number;
    unknown: number;
    outcome: "not_collected" | "partial" | "collected";
  };
}

interface ReceiptFile {
  value: JsonRecord;
  recordedAt: string;
}

export async function collectDashboardStats(root = process.cwd()): Promise<DashboardStats> {
  const projectRoot = resolve(root);
  const decisionDir = join(projectRoot, ".jevrouter", "decisions");
  const planDir = join(projectRoot, ".jevrouter", "plans");
  const [decisions, plans] = await Promise.all([
    readReceipts(decisionDir),
    readReceipts(planDir),
  ]);
  const decisionRows = decisions.files.map(({ value, recordedAt }) => ({
    decision_id: stringValue(value.decision_id) ?? "unknown",
    status: stringValue(value.status) ?? "unknown",
    selected: nestedString(value, ["decision", "selected"]),
    provider: nestedString(value, ["provenance", "jev_provider"]),
    source: nestedString(value, ["runtime", "source"]),
    elapsed_ms: nestedNumber(value, ["runtime", "elapsed_ms"]),
    recorded_at: recordedAt,
    execution: stringValue(nested(value, ["execution", "status"])),
  }));
  const elapsed = decisionRows.map(row => row.elapsed_ms).filter((value): value is number => value !== null).sort((a, b) => a - b);
  const selected = countBy(decisionRows.map(row => row.selected).filter((value): value is string => Boolean(value)));
  const execution = countExecution([
    ...decisionRows.map(row => row.execution),
    ...plans.files.flatMap(file => planSteps(file.value).map(step => nestedString(step, ["execution", "status"]))),
  ]);
  const planRows = plans.files.map(file => file.value);
  const planStepsList = planRows.flatMap(plan => planSteps(plan));
  return {
    generated_at: new Date().toISOString(),
    source: { root: projectRoot, decisions: decisionDir, plans: planDir, parse_errors: decisions.errors + plans.errors },
    decisions: {
      total: decisionRows.length,
      by_status: countBy(decisionRows.map(row => row.status)),
      by_source: countBy(decisionRows.map(row => row.source ?? "unknown")),
      by_provider: countBy(decisionRows.map(row => row.provider ?? "unknown")),
      avg_elapsed_ms: average(elapsed),
      p50_elapsed_ms: percentile(elapsed, 0.5),
      p95_elapsed_ms: percentile(elapsed, 0.95),
      selected_capabilities: Object.entries(selected).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, count]) => ({ id, count })),
      latest: decisionRows.sort((a, b) => b.recorded_at.localeCompare(a.recorded_at)).slice(0, 12).map(({ execution: _execution, ...row }) => row),
    },
    plans: {
      total: planRows.length,
      by_mode: countBy(planRows.map(plan => stringValue(plan.mode) ?? "unknown")),
      steps: planStepsList.length,
      by_status: countBy(planStepsList.map(step => stringValue(step.status) ?? "unknown")),
    },
    execution,
  };
}

export async function startDashboardServer(root = process.cwd(), port = 8788): Promise<Server> {
  const server = createServer(async (request, response) => {
    try {
      if (request.method !== "GET") return send(response, 405, { error: "method_not_allowed" });
      if (request.url === "/api/stats") return send(response, 200, await collectDashboardStats(root));
      if (request.url === "/health") return send(response, 200, { ok: true, service: "jevrouter-dashboard" });
      if (request.url === "/" || request.url === "/index.html") return sendHtml(response, dashboardHtml());
      return send(response, 404, { error: "not_found" });
    } catch (error) {
      return send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolveListen());
  });
  return server;
}

async function readReceipts(directory: string): Promise<{ files: ReceiptFile[]; errors: number }> {
  let names: string[];
  try { names = await readdir(directory); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: [], errors: 0 };
    throw error;
  }
  const files: ReceiptFile[] = [];
  let errors = 0;
  for (const name of names.filter(name => name.endsWith(".json")).sort()) {
    try {
      const path = join(directory, name);
      const value = JSON.parse(await readFile(path, "utf8")) as JsonRecord;
      const metadata = await stat(path);
      files.push({ value, recordedAt: metadata.mtime.toISOString() });
    } catch {
      errors += 1;
    }
  }
  return { files, errors };
}

function planSteps(value: JsonRecord): JsonRecord[] {
  return Array.isArray(value.steps) ? value.steps.filter(isRecord) : [];
}

function countExecution(statuses: Array<string | null>): DashboardStats["execution"] {
  const known = { not_started: 0, started: 0, succeeded: 0, failed: 0, unknown: 0 };
  for (const status of statuses) {
    if (status === "not_started") known.not_started += 1;
    else if (status === "started") known.started += 1;
    else if (status === "succeeded" || status === "completed") known.succeeded += 1;
    else if (status === "failed") known.failed += 1;
    else known.unknown += 1;
  }
  const observed = known.started + known.succeeded + known.failed;
  return { ...known, outcome: observed === 0 ? "not_collected" : known.unknown > 0 ? "partial" : "collected" };
}

function countBy(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function average(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  return values[Math.min(values.length - 1, Math.ceil(values.length * ratio) - 1)];
}

function nested(value: JsonRecord, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => isRecord(current) ? current[key] : undefined, value);
}
function nestedString(value: JsonRecord, path: string[]): string | null { return stringValue(nested(value, path)); }
function nestedNumber(value: JsonRecord, path: string[]): number | null { return numberValue(nested(value, path)); }
function stringValue(value: unknown): string | null { return typeof value === "string" && value.length ? value : null; }
function numberValue(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function isRecord(value: unknown): value is JsonRecord { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }

function send(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(`${JSON.stringify(body)}\n`);
}
function sendHtml(response: import("node:http").ServerResponse, html: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

export function dashboardHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>JevRouter Dashboard</title><style>
:root{color-scheme:dark;font:15px/1.5 system-ui,sans-serif;background:#0b0d12;color:#eef0f5}body{max-width:1120px;margin:0 auto;padding:36px 20px;background:radial-gradient(circle at 90% 0,#25203d 0,transparent 36%),#0b0d12}h1{margin:0 0 4px;font-size:32px}p{color:#aeb4c2;margin:0}.muted{color:#858c9c}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:24px 0}.card,section{background:#141820;border:1px solid #29303d;border-radius:14px;padding:16px}.value{font-size:28px;font-weight:700;margin-top:8px}.label{color:#9fa7b7;font-size:13px}.cols{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}@media(max-width:760px){.cols{grid-template-columns:1fr}}h2{font-size:18px;margin:0 0 12px}table{width:100%;border-collapse:collapse}td,th{text-align:left;border-top:1px solid #29303d;padding:8px 4px;font-size:13px}th{color:#9fa7b7;font-weight:500}.pill{display:inline-block;border-radius:999px;background:#252d3b;padding:2px 8px;margin:2px;font-size:12px}.notice{border-color:#6a5630;background:#211b11;margin-top:16px}.error{color:#ff9a9a}
</style></head><body><header><h1>JevRouter</h1><p>Local routing receipts · read-only dashboard</p></header><main id="app"><p>Loading local receipts…</p></main><script>
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const metric=(label,value)=>'<div class="card"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value)+'</div></div>';
const list=items=>Object.entries(items||{}).map(([key,value])=>'<span class="pill">'+esc(key)+': '+esc(value)+'</span>').join('')||'<span class="muted">none</span>';
async function load(){const app=document.querySelector('#app');try{const s=await fetch('/api/stats').then(r=>r.json());const d=s.decisions,p=s.plans,e=s.execution;app.innerHTML='<div class="grid">'+metric('Decisions',d.total)+metric('Selected',d.by_status.selected||0)+metric('Review / no decision',(d.by_status.needs_confirmation||0)+(d.by_status.no_decision||0))+metric('Plans',p.total)+metric('P50 latency',d.p50_elapsed_ms===null?'—':d.p50_elapsed_ms+' ms')+metric('P95 latency',d.p95_elapsed_ms===null?'—':d.p95_elapsed_ms+' ms')+'</div><div class="cols"><section><h2>Routing</h2><p>Status</p><div>'+list(d.by_status)+'</div><p>Source</p><div>'+list(d.by_source)+'</div><p>Provider</p><div>'+list(d.by_provider)+'</div><p class="muted">Top selected capabilities</p><div>'+list(Object.fromEntries(d.selected_capabilities.map(x=>[x.id,x.count])))+'</div></section><section><h2>Effect boundary</h2><div class="notice card"><strong>Execution outcome: '+esc(e.outcome==='not_collected'?'not collected':e.outcome)+'</strong><p class="muted">The dashboard counts local routing receipts. It does not claim that a host executed or completed a task.</p></div><p>Execution records</p><div>'+list({not_started:e.not_started,started:e.started,succeeded:e.succeeded,failed:e.failed,unknown:e.unknown})+'</div><p>Plan steps: '+esc(p.steps)+'</p><p>Plan statuses</p><div>'+list(p.by_status)+'</div></section></div><section style="margin-top:16px"><h2>Latest decisions</h2><table><thead><tr><th>Time</th><th>Status</th><th>Selected</th><th>Provider</th><th>Latency</th></tr></thead><tbody>'+d.latest.map(x=>'<tr><td>'+esc(new Date(x.recorded_at).toLocaleString())+'</td><td>'+esc(x.status)+'</td><td>'+esc(x.selected||'—')+'</td><td>'+esc(x.provider||'—')+'</td><td>'+esc(x.elapsed_ms===null?'—':x.elapsed_ms+' ms')+'</td></tr>').join('')+'</tbody></table></section><p class="muted" style="margin-top:16px">Updated '+esc(new Date(s.generated_at).toLocaleString())+' · parse errors: '+esc(s.source.parse_errors)+'</p>'}catch(error){app.innerHTML='<p class="error">Could not read local receipts: '+esc(error.message)+'</p>'}}load();setInterval(load,5000);
</script></body></html>`;
}
