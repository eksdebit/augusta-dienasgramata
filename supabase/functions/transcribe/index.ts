import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// Speech to text for Latvian voice notes. Uses OpenAI transcription (good Latvian support).
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const VOCAB = "Diabēta dienasgrāmata. Lantus, Apidra, Tresiba, NovoRapid, Humalog, Fiasp. Vienības, pusvienība, pusotra. MV, maizes vienības, ogļhidrāti, grami. Glikoze, cukurs, mmol, glikozes tablete. Brokastis, pusdienas, launags, vakariņas, uzkoda. Dexcom.";

function decode(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function transcribe(key: string, bytes: Uint8Array, mime: string, model: string) {
  const ext = /mp4|m4a|aac/.test(mime) ? "m4a" : /webm/.test(mime) ? "webm" : /ogg/.test(mime) ? "ogg" : /wav/.test(mime) ? "wav" : "m4a";
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: mime.split(";")[0] || "audio/mp4" }), "ieraksts." + ext);
  fd.append("model", model);
  fd.append("language", "lv");
  fd.append("prompt", VOCAB);
  fd.append("response_format", "json");
  return await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + key }, body: fd });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization") || "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  // Same rule as recognition: only diaries where the app owner has switched it on
  const m = await fetch(`${url}/rest/v1/members?select=child_id,children!inner(ai_enabled)&children.ai_enabled=is.true&limit=1`, { headers: { Authorization: auth, apikey: anon } });
  if (!m.ok) return json({ error: "Nav piekļuves" }, 401);
  const rows = await m.json();
  if (!Array.isArray(rows) || !rows.length) return json({ error: "Balss ievade šai dienasgrāmatai nav ieslēgta" }, 403);

  const key = (Deno.env.get("OPENAI_API_KEY") || "").replace(/\s+/g, "");
  if (!key) return json({ error: "Balss ievade vēl nav iestatīta (trūkst OpenAI atslēgas)" }, 503);

  let b: Record<string, string>;
  try { b = await req.json(); } catch { return json({ error: "Slikts pieprasījums" }, 400); }
  if (!b.audio || b.audio.length > 20_000_000) return json({ error: "Ieraksts nav pievienots vai ir par garu" }, 400);
  const bytes = decode(b.audio);
  const mime = b.mime || "audio/mp4";

  let r = await transcribe(key, bytes, mime, "gpt-4o-transcribe");
  if (!r.ok && r.status !== 401 && r.status !== 429) {
    console.error("gpt-4o-transcribe", r.status, (await r.text()).slice(0, 300));
    r = await transcribe(key, bytes, mime, "whisper-1");
  }
  if (!r.ok) {
    const t = await r.text();
    console.error("openai", r.status, t.slice(0, 500));
    return json({ error: r.status === 401 ? "OpenAI atslēga nav derīga" : r.status === 429 ? (/quota|billing/i.test(t) ? "OpenAI kontā nav līdzekļu" : "Pārāk daudz pieprasījumu, pagaidi brīdi") : "Runu neizdevās pārvērst tekstā" }, 502);
  }
  const data = await r.json();
  return json({ text: (data.text || "").trim() });
});
