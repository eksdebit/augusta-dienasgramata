import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const MODEL = "claude-sonnet-5-5";
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const RULES = `Ierakstu veidi (kind):
- "basal": ilgās darbības insulīns (Lantus, Tresiba, Levemir, Toujeo). Lauki: insulin, units.
- "bolus": īsās darbības insulīns (Apidra, NovoRapid, Humalog, Fiasp). Lauki: insulin, units.
- "meal": ēdienreize vai uzkoda. Lauki: meal ("Brokastis","Pusdienas","Launags","Vakariņas","Uzkoda"), items [{n: nosaukums, g: grami vai null, oh: aptuvenie ogļhidrāti gramos šai porcijai vai null}], mv (maizes vienības TIKAI ja tās skaidri pateiktas, citādi null).
- "glucose": cukura mērījums mmol/l, kas ir viens pats. Lauks: glucose.
- "tablets": glikozes tabletes. Lauks: count.
- "note": viss pārējais. Lauks: note.
Jebkuram ierakstam var būt note (īsa piezīme) un bg (glikozes līmenis mmol/l tajā brīdī, ja pateikts).`;

function textPrompt(b: Record<string, string>) {
  const isToday = b.cur === b.today;
  return `Tu esi palīgs bērna 1. tipa diabēta dienasgrāmatai latviešu valodā. Pārvērt mammas diktēto vai rakstīto tekstu strukturētos ierakstos.
Šodienas datums: ${b.today}, pašreizējais laiks: ${b.now}. Izvēlētā diena: ${b.cur}.

${RULES}

Noteikumi:
- "v", "vienība", "vienības" = insulīna vienības. "pusvienība"/"puse" = 0.5. "pusotra" = 1.5.
- "MV" vai "maizes vienības" = mv. Ja MV nav pateiktas, bet ir ēdieni, novērtē katra ēdiena ogļhidrātus "oh" pēc tipiskām uzturvērtībām (ja grami nav doti, pieņem tipisku bērna porciju un piezīmē raksti "porcija pieņemta"). Dzērieni bez cukura oh=0.
- Ja ēdienreizei pieminēta insulīna deva, izveido ATSEVIŠĶU bolus ierakstu tikai tad, ja skaidri teikts, ka tā ir iedota; citādi ieliec piezīmē, piem. "plānotā deva 1 v".
- Ja glikozes mērījums pateikts kopā ar insulīnu, ēdienu vai tableti, ieliec to kā bg pirmajam ierakstam ar to laiku, nevis atsevišķu "glucose" ierakstu.
- Cepums kopā ar glikozes tableti = atsevišķi ieraksti (Uzkoda + tablets) ar to pašu laiku.
- time formātā "HH:MM". Ja laiks nav pateikts: ${isToday ? `izmanto "${b.now}"` : `atstāj ""`}. Ja teikts "no rīta", "pusdienlaikā" bez precīza laika, izvēlies saprātīgu laiku un piezīmē raksti "laiks aptuvens".
- Nesacer datus, kas nav teikti. Saglabā ēdienu nosaukumus, kā teikts, izlabojot acīmredzamas diktēšanas kļūdas.
- Skaitļi kā JSON skaitļi (punkts kā decimālatdalītājs).

Atbildi TIKAI ar JSON: {"entries":[{"time":"HH:MM","kind":"...", ...}]}

Teksts:
"""${(b.text || "").slice(0, 4000)}"""`;
}

function menuPrompt(b: Record<string, string>) {
  return `Attēlā ir ēdienkarte (piem. bērnudārza vai skolas dienas ēdienkarte, restorāna ēdienkarte) vai ēdiena šķīvis. Tas ir bērna 1. tipa diabēta dienasgrāmatai.
Šodien: ${b.today}, laiks ${b.now}. Izvēlētā diena: ${b.cur}.
${b.text ? `Mammas komentārs: "${b.text.slice(0, 1000)}"\n` : ""}
Uzdevums: izveido ēdienreizes ierakstus ar katra ēdiena aptuveniem ogļhidrātiem.
- Ja ēdienkartē ir vairākas ēdienreizes (brokastis, pusdienas, launags), izveido katrai savu "meal" ierakstu.
- Ja ēdienkartē norādīti porciju grami, izmanto tos. Ja nav, pieņem tipisku bērna porciju un piezīmē raksti "porcija pieņemta".
- Ja ēdienkartē norādīti ogļhidrāti, izmanto tos.
- oh = ogļhidrāti gramos visai porcijai, novērtē pēc tipiskām uzturvērtībām. mv atstāj null.
- Ja attēlā nav ēdiena vai to nevar nolasīt, atgriez tukšu sarakstu un "error" ar īsu paskaidrojumu latviski.
- time: ja komentārā laiks pateikts, izmanto to; citādi Brokastis 08:30, Pusdienas 12:30, Launags 15:30, Vakariņas 18:30 un piezīmē "laiks aptuvens".

Formāts: {"entries":[{"time":"HH:MM","kind":"meal","meal":"Pusdienas","items":[{"n":"...","g":150,"oh":18}],"mv":null,"note":"..."}],"error":null}
Atbildi TIKAI ar JSON.`;
}

function notesPrompt(b: Record<string, string>) {
  return `Attēlā ir ar roku rakstīta lapa no papīra dienasgrāmatas bērnam ar 1. tipa diabētu (latviešu valodā). Pārraksti to strukturētos ierakstos.
Šodien: ${b.today}. Lietotnē izvēlētā diena: ${b.cur}.
${b.text ? `Mammas komentārs: "${b.text.slice(0, 1000)}"\n` : ""}
${RULES}

Kā parasti raksta šajā dienasgrāmatā:
- Lapas augšā bieži ir datums (piem. "26 Oktobris"); ja datums redzams, atgriez to laukā "date" formātā YYYY-MM-DD (gads: ${b.today.slice(0, 4)}, ja nav rakstīts). Ja datuma nav, "date": null.
- "7:20 -> Lantus 3v" = basal 3 vienības plkst. 7:20. "Apidra 0.5v" = bolus. "v" = vienības.
- "B." = Brokastis, "P." = Pusdienas, "L." = Launags, "V." = Vakariņas (ja "V." stāv ēdienreižu sarakstā). Zem tām ir ēdieni ar gramiem ("150g").
- Malā pie ēdienreizes bieži ir "2MV", "3,5MV" — tās ir šīs ēdienreizes maizes vienības (mv).
- Malā aplī ievilkts skaitlis ar vai bez "v" (piem. "(1v)", "(1)") — ar ēdienreizi saistītā insulīna deva; ja pie tās nav atsevišķa laika, ieliec ēdienreizes piezīmē "deva N v"; neveido bolus ierakstu, ja tā pati deva jau ir pierakstīta ar laiku.
- "1 glikozes tablete" = tablets; "1 cepums" = Uzkoda ar cepumu.
- Piezīmes kā "skatāmies cukuru", "1 vai 1,5" ieliec note.
- Ēdienreizes laiku, ja nav rakstīts, ņem no blakus esošās laika skalas lapas malā un piezīmē raksti "laiks aptuvens".
- Pārsvītrots teksts neskaitās. Lapas augšā esošie citi uzdevumi (piem. iepirkumi), kas nav par bērna veselību, NEVEIDO ierakstus.
- Ja kādu vārdu vai skaitli nevar droši salasīt, raksti savu labāko minējumu un pievieno piezīmē "nesalasāms: …". Nekad nesacer skaitļus.
- Ēdieniem oh atstāj null, ja nav rakstīts; mv tikai tad, ja rakstīts.

Atbildi TIKAI ar JSON: {"date":"YYYY-MM-DD vai null","entries":[{"time":"HH:MM","kind":"...", ...}],"error":null}
Ja attēlā nav dienasgrāmatas pierakstu, atgriez tukšu sarakstu un "error" ar īsu paskaidrojumu latviski.`;
}

function meterPrompt() {
  return `Attēlā ir glikometra ekrāns ar asins glikozes mērījumu no pirksta (bērna 1. tipa diabēta dienasgrāmatai).
Nolasi galveno skaitli uz ekrāna. Ja ekrānā redzams laiks vai datums, nolasi arī tos.
Atbildi TIKAI ar JSON: {"glucose": skaitlis vai null, "unit": "mmol/L" vai "mg/dL" vai null, "time": "HH:MM" vai null, "date": "YYYY-MM-DD" vai null, "error": null vai īss paskaidrojums latviski}.
Ja ekrānā ir LO vai HI, atgriez glucose null un error ar paskaidrojumu. Ja tas nav glikometra ekrāns, atgriez error.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const auth = req.headers.get("Authorization") || "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  // Only members of a diary where the app owner has switched recognition on may use the API key
  const m = await fetch(`${url}/rest/v1/members?select=child_id,children!inner(ai_enabled)&children.ai_enabled=is.true&limit=1`, { headers: { Authorization: auth, apikey: anon } });
  if (!m.ok) return json({ error: "Nav piekļuves" }, 401);
  const rows = await m.json();
  if (!Array.isArray(rows) || !rows.length) return json({ error: "Atpazīšana šai dienasgrāmatai nav ieslēgta" }, 403);

  const key = (Deno.env.get("ANTHROPIC_API_KEY") || "").replace(/\s+/g, "");
  if (!key) return json({ error: "Atpazīšana vēl nav iestatīta (trūkst API atslēgas)" }, 503);

  let b: Record<string, string>;
  try { b = await req.json(); } catch { return json({ error: "Slikts pieprasījums" }, 400); }
  const mode = b.mode || "text";
  const content: unknown[] = [];
  if (mode === "menu" || mode === "meter" || mode === "notes") {
    if (!b.image || b.image.length > 7_000_000) return json({ error: "Attēls nav pievienots vai ir par lielu" }, 400);
    content.push({ type: "image", source: { type: "base64", media_type: b.mediaType || "image/jpeg", data: b.image } });
  }
  content.push({ type: "text", text: mode === "menu" ? menuPrompt(b) : mode === "notes" ? notesPrompt(b) : mode === "meter" ? meterPrompt() : textPrompt(b) });

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: mode === "notes" ? 4000 : 2500, messages: [{ role: "user", content }] }),
  });
  if (!r.ok) {
    const t = await r.text();
    console.error("anthropic", r.status, t.slice(0, 500));
    return json({ error: r.status === 429 ? "Pārāk daudz pieprasījumu, pagaidi brīdi" : r.status === 401 ? "API atslēga nav derīga" : r.status === 400 && /credit/i.test(t) ? "Anthropic kontā nav līdzekļu" : "Atpazīšana neizdevās" }, 502);
  }
  const data = await r.json();
  const text = (data.content || []).filter((c: { type: string }) => c.type === "text").map((c: { text: string }) => c.text).join("");
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e < s) return json({ error: "Atpazīšana neizdevās" }, 502);
  try { return json(JSON.parse(text.slice(s, e + 1))); }
  catch { return json({ error: "Atpazīšana neizdevās" }, 502); }
});
