
// src/index.ts
// CoatDoctor – Cloudflare Worker (TypeScript, ES Modules)
// Endpoints: /api/health, /api/seed, /api/analyze, /api/chat, /api/upload

export interface Env {
  AI: Ai;                       // Workers AI binding
  DEFECT_IMAGES: R2Bucket;      // R2 bucket binding (optional but recommended)
  VECTORIZE_INDEX: VectorizeIndex; // Vectorize index binding (optional, but enables semantic search)
}

/* ----------------------- Small utilities ----------------------- */

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",            // tighten in prod (e.g. https://coatdoctor.com)
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
  };
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}

async function readJsonSafe(request: Request): Promise<any | null> {
  try { return await request.json(); }
  catch { return null; }
}

function sanitizeFileName(name?: string): string {
  return (name || "").toString().replace(/[^\w.\-]+/g, "_").slice(0, 160);
}

function stripDataUrlPrefix(dataUrl?: string): string {
  if (!dataUrl) return "";
  const i = dataUrl.indexOf(",");
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/* ----------------------- Knowledge base (SOPs) ----------------------- */

type SopEntry = {
  code: string;
  name: string;
  severity: "Low" | "Medium" | "High";
  text: string;
  root_causes: string[];
  corrective_actions: string[];
};

const KB: SopEntry[] = [
  {
    code: "CD001-OP",
    name: "Orange peel – textured surface",
    severity: "Medium",
    text:
      "Uneven, orange-skin texture of the coating film. Usually linked to viscosity/leveling, excessive wet film, and overly aggressive early drying (skinning).",
    root_causes: [
      "Viscosity outside process window (too high → poor leveling)",
      "Excess wet film thickness (especially at head)",
      "Aggressive early drying (IR/hot air) causing skinning",
      "Insufficient airflow / uneven leveling time"
    ],
    corrective_actions: [
      "Adjust viscosity to SOP DIN-4 window and re-check leveling",
      "Reduce wet film thickness; verify application weight",
      "Soften first zone drying; avoid premature skinning",
      "Balance airflow; run structured speed/viscosity tests"
    ]
  },
  {
    code: "CD002-PH",
    name: "Pinholes / small craters",
    severity: "High",
    text:
      "Small holes/craters after baking; typically contamination, trapped volatiles or foam from turbulent mixing/pumping.",
    root_causes: [
      "Air entrainment/turbulent mixing causing micro-bubbles",
      "Surface contamination (oil/silicone) at substrate/rollers",
      "Solvent balance → too fast surface evaporation traps volatiles",
      "Humidity peaks / dirty environment"
    ],
    corrective_actions: [
      "Degas lacquer; avoid turbulent mixing/pumping; check pump setup",
      "Clean substrate, rollers and environment thoroughly",
      "Adjust solvent balance/oven; slower initial evaporation profile",
      "Compare lab bake vs line to isolate process vs formulation"
    ]
  },
  {
    code: "CD003-LN",
    name: "Streaks / lines",
    severity: "Medium",
    text:
      "Linear defects tied to doctor blade or roller condition; mechanical inspection and alignment are key.",
    root_causes: [
      "Doctor blade wear/damage or incorrect pressure",
      "Roller damage/mapping correlating with repeat length",
      "Flow/viscosity imbalance amplifying mechanical marks"
    ],
    corrective_actions: [
      "Inspect/replace blade; set correct pressure and alignment",
      "Map rollers vs defect repeat; regrind/replace if needed",
      "Cross-check viscosity/flow; run elimination tests"
    ]
  },
  {
    code: "CD004-AD",
    name: "Poor adhesion / flaking",
    severity: "High",
    text:
      "Loss of adhesion between layers; check pretreatment, cure of previous coats and mixing/hardener ratio.",
    root_causes: [
      "Pre-treatment off-spec (washing/chemistry)",
      "Under-bake of previous layer or extreme over-bake",
      "Incorrect hardener ratio / exceeded pot life",
      "Surface contamination (oil/silicone)"
    ],
    corrective_actions: [
      "Verify pretreatment parameters + documentation",
      "Check oven curve; correct under/over-bake scenarios",
      "Validate hardener ratio/pot life; mix fresh batch",
      "Perform tape test per SOP; ensure cleanliness"
    ]
  },
  {
    code: "CD005-STK",
    name: "Sticking after side print",
    severity: "Medium",
    text:
      "Blocking of side-printed sheets/caps; cooling/stack rules and film build management are central.",
    root_causes: [
      "Insufficient cooling and improper stack management",
      "Film build too high causing blocking",
      "Crosslinker/lacquer batch sensitivity"
    ],
    corrective_actions: [
      "Improve cooling; enforce stack height rules",
      "Run small batch + lab oven tests to compare line vs lab",
      "Evaluate crosslinker/lacquer batch; adjust formulation window"
    ]
  }
];

function findSop(code?: string): SopEntry | undefined {
  return KB.find(e => e.code === code);
}

/* ----------------------- Workers AI helpers ----------------------- */

/** Create embeddings for 1..N texts with BGE Base (768D). */
async function embedTexts(env: Env, texts: string[]): Promise<number[][]> {
  const res = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: texts });
  // Expect res.data: number[][]
  return res?.data ?? [];
}

/** Short constrained explanation/rationale using Llama 3.1 instruct. */
async function llmRationale(env: Env, description: string, match: any): Promise<string> {
  const sys = [
    "You are CoatDoctor – an expert-first assistant.",
    "Only explain existing codes CD001–CD005. Never invent new codes.",
    "Output a short rationale and 3–5 actions a technologist would start with."
  ].join("\n");

  const resp = await env.AI.run("@cf/meta/llama-3.1-8b-instruct", {
    messages: [
      { role: "system", content: sys },
      { role: "user", content: `Description: ${description}\nMatch: ${JSON.stringify(match)}` }
    ],
    temperature: 0.1,
    max_tokens: 400
  });

  return (resp && (resp.response as string)) || "";
}

/* ----------------------- Vectorize helpers ----------------------- */

/** Seed KB into Vectorize (upsert). Returns mutationId or null. */
async function seedKBIntoVectorize(env: Env): Promise<string | null> {
  if (!env.VECTORIZE_INDEX) return null;

  const texts = KB.map(k => k.text);
  const vecs = await embedTexts(env, texts);

  const payload = vecs.map((values, i) => ({
    id: KB[i].code,
    values,
    metadata: {
      code: KB[i].code,
      name: KB[i].name,
      severity: KB[i].severity
    }
  }));

  const res = await env.VECTORIZE_INDEX.upsert(payload);
  // V2 upserts are async and return mutationId (available after a short time).
  return res?.mutationId ?? null;
}

/** Query Vectorize with the description embedding; return best match or null. */
async function vectorizeMatch(env: Env, description: string): Promise<any | null> {
  if (!env.VECTORIZE_INDEX) return null;
  const [vec] = await embedTexts(env, [description]);
  if (!vec) return null;

  const results = await env.VECTORIZE_INDEX.query(vec, {
    topK: 3,
    returnMetadata: "all"
  });

  const best = results?.matches?.[0];
  if (!best) return null;

  return {
    code: best.metadata?.code ?? best.id,
    name: best.metadata?.name ?? "",
    severity: best.metadata?.severity ?? "Medium",
    score: best.score
  };
}

/* ----------------------- Route handlers ----------------------- */

async function handleHealth(): Promise<Response> {
  return json({ ok: true, service: "coatdoctor-worker" });
}

async function handleSeed(env: Env): Promise<Response> {
  if (!env.VECTORIZE_INDEX) return json({ ok: false, error: "VECTORIZE_INDEX binding missing" }, 500);
  const mutationId = await seedKBIntoVectorize(env);
  return json({ ok: true, mutationId });
}

async function handleAnalyze(request: Request, env: Env): Promise<Response> {
  const body = await readJsonSafe(request);
  if (!body) return json({ ok: false, error: "Invalid JSON" }, 400);

  const description = (body.description ?? "").toString();
  const image_b64 = (body.image_base64 ?? "").toString();
  const filenameIn = sanitizeFileName(body.filename ?? "");

  // Optional: store image in R2
  let image_key: string | null = null;
  if (env.DEFECT_IMAGES && image_b64) {
    try {
      const base64 = stripDataUrlPrefix(image_b64);
      const bytes = decodeBase64ToBytes(base64);
      image_key = `uploads/${Date.now()}_${filenameIn || "defect.jpg"}`;
      await env.DEFECT_IMAGES.put(image_key, bytes, {
        httpMetadata: { contentType: "image/jpeg" }
      });
    } catch {
      /* non-fatal */
    }
  }

  // Prefer Vectorize match (if binding exists), else fallback by simple keyword score
  let best_match = await vectorizeMatch(env, description);

  if (!best_match) {
    // Deterministic keyword fallback (simple score)
    const t = description.toLowerCase();
    const scored = KB.map(e => ({
      entry: e,
      score:
        (e.text.toLowerCase().includes("orange") && t.includes("orange peel") ? 2 : 0) +
        (e.text.toLowerCase().includes("pinhole") && (t.includes("pinholes") || t.includes("crater"))) ? 2 : 0 +
        (t.includes("adhesion") || t.includes("tape test") ? (e.code === "CD004-AD" ? 2 : 0) : 0)
    }));
    scored.sort((a, b) => b.score - a.score);
    const top = scored[0]?.entry ?? KB[0];
    best_match = { code: top.code, name: top.name, severity: top.severity, score: scored[0]?.score ?? 0 };
  }

  const defect = findSop(best_match.code) ?? KB[0];
  const rationale = await llmRationale(env, description, best_match);

  return json({
    ok: true,
    image_key,
    best_match,
    defect: {
      code: defect.code,
      name: defect.name,
      severity: defect.severity,
      root_causes: defect.root_causes,
      corrective_actions: defect.corrective_actions
    },
    rationale
  });
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const message = (body.message ?? "").toString().trim();
  if (!message || message.length < 3) {
    return json({
      reply: "Please describe the defect in more detail – substrate, coating type, drying, line speed, etc."
    });
  }

  // Reuse analyze
  const analyzeRes = await handleAnalyze(
    new Request(new URL("/api/analyze", request.url).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: message })
    }),
    env
  );

  const data = await analyzeRes.json();
  if (!data || data.ok === false) {
    return json({ reply: "I could not reach the analysis engine right now. Please try again later." }, 200);
  }

  const { best_match, defect, rationale } = data;
  let reply = "";
  reply += `Based on your description, a likely match is:\n`;
  reply += `• Code: ${best_match?.code}\n`;
  reply += `• Name: ${defect?.name}\n`;
  reply += `• Severity: ${best_match?.severity ?? defect?.severity}\n`;
  if (typeof best_match?.score === "number") reply += `• Match score (demo): ${best_match.score}\n\n`;
  reply += rationale || "Full SOP steps are part of the CoatDoctor handbook and internal engine.";

  return json({ reply }, 200);
}

async function handleUpload(request: Request, env: Env): Promise<Response> {
  if (!env.DEFECT_IMAGES) return json({ error: "R2 bucket not configured" }, 500);

  const body = await readJsonSafe(request);
  if (!body) return json({ error: "Invalid JSON" }, 400);

  const filename = sanitizeFileName(body.filename || "");
  const contentType = (body.contentType || "image/jpeg").toString();
  const base64Data = (body.data || "").toString();
  if (!filename || !base64Data) return json({ error: "Missing filename or data" }, 400);

  let bytes: Uint8Array;
  try {
    const base64 = stripDataUrlPrefix(base64Data);
    bytes = decodeBase64ToBytes(base64);
  } catch {
    return json({ error: "Invalid base64 data" }, 400);
  }

  const key = `clients/${filename}`;
  await env.DEFECT_IMAGES.put(key, bytes, { httpMetadata: { contentType } });
  return json({ ok: true, key });
}

/* ----------------------- Router ----------------------- */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/api/health" && request.method === "GET") {
        return await handleHealth();
      }

      if (url.pathname === "/api/seed" && request.method === "POST") {
        return await handleSeed(env);
      }

      if (url.pathname === "/api/analyze" && request.method === "POST") {
        return await handleAnalyze(request, env);
      }

      if (url.pathname === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }

      if (url.pathname === "/api/upload" && request.method === "POST") {
        return await handleUpload(request, env);
      }

      return new Response("Not found", { status: 404, headers: corsHeaders() });
    } catch (err: any) {
      return json({ ok: false, error: String(err?.message ?? err) }, 500);
    }
  }
};
