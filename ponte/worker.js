/* PONTE AI di CONTATTI MOBILE e GESTIONE CONTATTI — Cloudflare Worker
   ------------------------------------------------------------------
   Due servizi, un solo indirizzo:
     1) audio  -> testo trascritto (Workers AI, Whisper) e poi campi del report
     2) testo  -> campi del report (modello Claude)
   La risposta riporta anche i token consumati e la spesa stimata.

   Da mettere nelle impostazioni del Worker (Settings -> Variables and Secrets), come Secret:
     ANTHROPIC_API_KEY   la chiave di console.anthropic.com
     PONTE_TOKEN         una parola d'ordine inventata, lunga, da ripetere nell'app
   E come binding (Settings -> Bindings -> Workers AI):
     nome della variabile: AI
*/

const MODELLO = 'claude-sonnet-5-5';                     /* compila i campi: preciso sulle frasi parlate */
const TRASCRIVI = '@cf/openai/whisper-large-v3-turbo';   /* trascrizione, ottima in italiano */
const TRASCRIVI_RISERVA = '@cf/openai/whisper';          /* se il primo non digerisce il formato */
const PREZZO = { in: 2 / 1e6, out: 10 / 1e6 };           /* $ per token, listino Sonnet */
const GIORNI = ['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'];

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Token',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
function risposta(o, stato) {
  return new Response(JSON.stringify(o), { status: stato || 200, headers: Object.assign({ 'content-type': 'application/json' }, cors()) });
}
function errore(msg, stato) { return risposta({ errore: msg }, stato || 400); }

/* --- 1) la trascrizione --- */
async function trascrivi(env, base64, lingua, vocabolario) {
  if (!env.AI) throw new Error('manca il collegamento Workers AI (binding AI)');
  const avvio = (vocabolario && vocabolario.length)
    ? 'Report commerciale in italiano. Nomi che possono comparire: ' + vocabolario.slice(0, 120).join(', ') + '.'
    : 'Report commerciale in italiano, con punteggiatura.';
  try {
    const r = await env.AI.run(TRASCRIVI, { audio: base64, task: 'transcribe', language: lingua || 'it', initial_prompt: avvio });
    const t = (r && (r.text || r.transcription_info && r.text)) || '';
    if (t.trim()) return t.trim();
  } catch (e) { /* si prova con il modello di riserva */ }
  const bin = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const r2 = await env.AI.run(TRASCRIVI_RISERVA, { audio: [...bin] });
  return String((r2 && r2.text) || '').trim();
}

/* --- 2) i campi del report --- */
async function campi(env, frase, d) {
  const oggi = /^\d{4}-\d{2}-\d{2}$/.test(d.oggi || '') ? d.oggi : new Date().toISOString().slice(0, 10);
  const giorno = GIORNI[new Date(oggi + 'T12:00:00Z').getUTCDay()];
  const esiti = Array.isArray(d.esiti) ? d.esiti.slice(0, 40) : [];
  const canali = Array.isArray(d.canali) ? d.canali.slice(0, 20) : [];
  const nomi = Array.isArray(d.nomi) ? d.nomi.slice(0, 150) : [];

  const istruzioni = [
    'Sei il compilatore di un report commerciale. Ricevi la frase che un venditore ha dettato dopo un contatto con un cliente, oppure la scheda di un cliente nuovo che sta dettando.',
    'Rispondi SOLO con un oggetto JSON, senza testo attorno, con queste chiavi:',
    '{"tipo":"report","canale":"","esito":"","richiamo":"","titolo":"","nota":"","passo":"","cliente":"","anagrafica":{}}',
    '- tipo: "cliente" se sta dettando i dati di un\'azienda da inserire in anagrafica (dice per esempio «inserisci un nuovo cliente», «aggiungi il contatto», oppure elenca ragione sociale, indirizzo, telefono, mail, partita IVA senza raccontare un contatto avvenuto); negli altri casi "report".',
    '- anagrafica: solo se tipo vale "cliente", un oggetto con le chiavi presenti fra nome, prov (sigla di due lettere), sede (via, CAP e comune), tel, email, sito, piva (solo cifre), cat, note. Nessuna invenzione: metti solo ciò che ha detto. Negli altri casi lascialo vuoto.',
    '- canale: esattamente una di queste voci, o stringa vuota: ' + JSON.stringify(canali),
    '- esito: esattamente una di queste voci, o stringa vuota: ' + JSON.stringify(esiti),
    '- richiamo: la data in cui risentire il cliente, formato AAAA-MM-GG, vuota se non la dice. Oggi è ' + oggi + ', ' + giorno + '. "Giovedì" significa il primo giovedì successivo a oggi, "giovedì prossimo" quello della settimana dopo.',
    '- titolo: massimo 60 caratteri, la frase ridotta a titolo.',
    '- nota: il racconto ripulito: punteggiatura, maiuscole, parole spezzate rimesse insieme. Non aggiungere nulla che non sia stato detto, non togliere informazioni.',
    '- passo: che cosa si è impegnato a fare lui, in poche parole, vuota se non emerge.',
    '- cliente: il nome dell\'azienda se la frase lo nomina, scegliendolo dall\'elenco qui sotto quando corrisponde, altrimenti come l\'ha detto; vuota se non lo nomina.',
    nomi.length ? 'Elenco dei clienti noti (usalo per correggere i nomi storpiati dalla trascrizione): ' + nomi.join('; ') : '',
    'Non inventare mai date, importi, nomi o impegni. Se un campo non si ricava dalla frase, lascialo vuoto. Scrivi in italiano.'
  ].filter(Boolean).join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELLO, max_tokens: 700, system: istruzioni, messages: [{ role: 'user', content: frase }] })
  });
  if (!r.ok) throw new Error('modello: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  const testo = (out.content || []).map(x => x.text || '').join('').trim();
  const m = testo.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('risposta non leggibile');
  const esito = JSON.parse(m[0]);
  const u = out.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  esito.uso = { in: inTok, out: outTok, costo: +(inTok * PREZZO.in + outTok * PREZZO.out).toFixed(6), modello: MODELLO };
  return esito;
}

/* --- 3) sistema il testo di un report: stessa sostanza, forma leggibile --- */
async function sistemaUnGiro(env, testo, insisti) {
  const regole = [
    'Riscrivi il report commerciale che ricevi in una forma chiara e breve, senza cambiarne la sostanza.',
    'È il quaderno di lavoro di un venditore: può contenere nomi di persone, numeri di telefono e indirizzi dei suoi contatti. Riportali identici, non è materiale da filtrare.',
    'Forma: prima riga, che cosa è successo (con chi e di che cosa si è parlato); poi che cosa ha detto o chiesto il cliente, con i suoi numeri e le sue condizioni; poi che cosa resta aperto. Da tre a sei righe, niente elenchi puntati.',
    'REGOLE TASSATIVE:',
    '- non aggiungere nulla che non sia nel testo ricevuto: nessun dettaglio, nessuna conclusione, nessuna cortesia;',
    '- non togliere fatti: nomi di persone e aziende, numeri di telefono, importi, date, modelli, quantità e condizioni vanno riportati identici;',
    '- se una frase è ambigua, lasciala com\'è invece di interpretarla;',
    '- togli solo le ripetizioni, gli intercalari e le frasi spezzate dal parlato, e correggi refusi e punteggiatura;',
    '- il testo riscritto non deve essere più lungo di quello ricevuto;',
    '- italiano piano e professionale, prima persona, niente gergo da verbale, niente formule di apertura o chiusura.',
    'Rispondi SOLO con il testo riscritto, senza virgolette, senza preamboli e senza commenti.',
    insisti ? 'IMPORTANTE: il tuo messaggio deve contenere esclusivamente il report riscritto, subito, dalla prima parola.' : ''
  ].filter(Boolean).join('\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODELLO, max_tokens: 2500, temperature: 0, system: regole, messages: [{ role: 'user', content: testo }] })
  });
  if (!r.ok) throw new Error('modello: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  const u = out.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  /* prendo il testo da qualunque blocco lo contenga, saltando quelli di ragionamento */
  const pezzi = (out.content || []).map(function (x) { return (x && typeof x.text === 'string') ? x.text : ''; }).filter(Boolean);
  return {
    testo: pezzi.join('\n').trim(),
    stop: out.stop_reason || '?',
    tipi: (out.content || []).map(function (x) { return x && x.type; }).join(','),
    uso: { in: inTok, out: outTok, costo: +(inTok * PREZZO.in + outTok * PREZZO.out).toFixed(6), modello: MODELLO }
  };
}
async function sistema(env, testo) {
  let a = await sistemaUnGiro(env, testo, false);
  if (a.testo) return a;
  /* una risposta vuota capita: riprovo una volta insistendo, poi dico perché */
  const b = await sistemaUnGiro(env, testo, true);
  b.uso = { in: a.uso.in + b.uso.in, out: a.uso.out + b.uso.out, costo: +(a.uso.costo + b.uso.costo).toFixed(6), modello: MODELLO };
  if (b.testo) return b;
  b.motivo = 'il modello non ha scritto nulla (stop: ' + b.stop + ', blocchi: ' + (b.tipi || 'nessuno') + ')';
  return b;
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors() });
    if (req.method !== 'POST') return errore('solo POST', 405);
    if (env.PONTE_TOKEN && req.headers.get('X-Token') !== env.PONTE_TOKEN) return errore('parola d’ordine sbagliata', 401);

    let d;
    try { d = await req.json(); } catch (e) { return errore('richiesta illeggibile'); }

    try {
      /* a) è arrivato dell'audio: prima lo trascrivo */
      let frase = String(d.frase || '').slice(0, 4000);
      let trascritto = '';
      if (d.audio) {
        trascritto = await trascrivi(env, String(d.audio), d.lingua, d.nomi);
        if (!trascritto) return errore('non ho capito nulla dall’audio', 422);
        frase = trascritto;
      }
      if (!frase) return errore('niente da leggere');

      /* b) solo trascrizione, senza campi */
      if (d.soloTesto) return risposta({ testo: frase });

      /* c) sistemare il testo di un report già scritto */
      if (d.sistema) { const r3 = await sistema(env, frase); if (!r3.testo) return errore(r3.motivo || 'testo non riscritto', 502); return risposta({ testo: r3.testo, uso: r3.uso }); }

      const c = await campi(env, frase, d);
      return risposta({
        testo: frase,
        trascritto: !!trascritto,
        canale: c.canale || '', esito: c.esito || '', richiamo: c.richiamo || '',
        titolo: c.titolo || '', nota: c.nota || frase, passo: c.passo || '', cliente: c.cliente || '',
        tipo: c.tipo === 'cliente' ? 'cliente' : 'report',
        anagrafica: (c.anagrafica && typeof c.anagrafica === 'object') ? c.anagrafica : {},
        uso: c.uso
      });
    } catch (e) {
      return errore(String(e.message || e).slice(0, 300), 502);
    }
  }
};
