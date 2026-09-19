const JEVO_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const JEVO_MODEL = "~typesafe/jev-latest";
const JEVO_MODEL_FAMILY = "typesafe/jev-";

export async function onRequestPost(context) {
  const key = context.env.OPENROUTER_API_KEY;
  if (!key) return json({ error: "Playground is not configured." }, 503);
  let input;
  try { input = await context.request.json(); } catch { return json({ error: "Invalid JSON request." }, 400); }
  if (!input || typeof input.request !== "string" || !Array.isArray(input.candidates) || input.candidates.length < 2) {
    return json({ error: "A request and at least two candidates are required." }, 400);
  }
  const criteria = Object.fromEntries(input.candidates.map(candidate => [candidate.id, `${candidate.name}: ${candidate.description}`]));
  const upstream = await fetch(JEVO_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "HTTP-Referer": "https://www.jevrouter.co/", "X-OpenRouter-Title": "JevRouter Playground" },
    body: JSON.stringify({ state: { request: input.request, candidates: input.candidates }, model: JEVO_MODEL, questions: input.questions ?? { tool: { type: "choice", instructions: "Which single capability should handle this request? Choose only from the supplied options.", criteria } } }),
  });
  const body = await upstream.json().catch(() => ({}));
  if (!upstream.ok) return json({ error: body.error?.message || `OpenRouter returned HTTP ${upstream.status}` }, upstream.status);
  const resolvedModel = body.model || "unknown";
  if (!resolvedModel.startsWith(JEVO_MODEL_FAMILY)) return json({ error: "Unexpected model returned." }, 502);
  return json({ provider: "openrouter", model_requested: JEVO_MODEL, model_resolved: resolvedModel, decision_id: body.id, answer: body.answers?.tool, usage: body.usage });
}

function json(body, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }); }
