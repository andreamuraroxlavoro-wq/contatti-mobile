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
/* i modelli che l'app puo' scegliere, con il loro listino: il conto dei consumi segue il modello usato */
const MODELLI = {
  'claude-sonnet-5-5': { in: 2 / 1e6, out: 10 / 1e6 },
  'claude-haiku-5-5': { in: 0.10 / 1e6, out: 0.50 / 1e6 }
};
function modelloDi(d) { const m = d && d.modello; return MODELLI[m] ? m : MODELLO; }
function prezzoDi(m) { return MODELLI[m] || PREZZO; }
function contoUso(out, m) {
  const u = out.usage || {};
  const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const outTok = u.output_tokens || 0;
  const pr = prezzoDi(m);
  return { in: inTok, out: outTok, costo: +(inTok * pr.in + outTok * pr.out).toFixed(6), modello: m };
}
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
    '{"tipo":"report","canale":"","esito":"","richiamo":"","titolo":"","nota":"","passo":"","cliente":"","quando":"","ora":"","anagrafica":{}}',
    '- tipo: una di queste cinque parole.',
    '   "report" = racconta un contatto GIA\' avvenuto (sono andato, ho chiamato, ho mandato, mi ha detto);',
    '   "visita" = chiede di mettere in calendario una visita DA FARE (vai, passa, fissa una visita, devo andare);',
    '   "telefonata" = chiede di mettere in calendario una chiamata DA FARE (devo chiamare, ricordami di telefonare);',
    '   "mail" = chiede di mettere in calendario una mail DA MANDARE (devo scrivere, mandare una mail);',
    '   "cliente" = sta dettando i dati di un\'azienda da inserire in anagrafica (inserisci un nuovo cliente, aggiungi il contatto, oppure elenca ragione sociale, indirizzo, telefono, mail, partita IVA senza raccontare un contatto).',
    '   Nel dubbio fra un contatto avvenuto e uno da fare guarda i verbi: al passato e\' "report", all\'imperativo o al futuro e\' un\'attivita\' da fare.',
    '- quando: SOLO per visita, telefonata e mail: il giorno in cui va fatta, formato AAAA-MM-GG, vuoto se non lo dice.',
    '- ora: SOLO per visita, telefonata e mail: l\'orario in formato HH:MM (24 ore), vuoto se non lo dice. «Dieci e mezza» del mattino e\' 10:30, «alle tre» del pomeriggio e\' 15:00.',
    '- anagrafica: solo se tipo vale "cliente", un oggetto con le chiavi presenti fra nome, prov (sigla di due lettere), sede (via, CAP e comune), tel, email, sito, piva (solo cifre), cat, note. Nessuna invenzione: metti solo ciò che ha detto. Negli altri casi lascialo vuoto.',
    '- canale: esattamente una di queste voci, o stringa vuota: ' + JSON.stringify(canali),
    '- esito: esattamente una di queste voci, o stringa vuota: ' + JSON.stringify(esiti),
    '- richiamo: la data in cui risentire il cliente, formato AAAA-MM-GG, vuota se non la dice. Oggi è ' + oggi + ', ' + giorno + '. "Giovedì" significa il primo giovedì successivo a oggi, "giovedì prossimo" quello della settimana dopo.',
    '- titolo: massimo 60 caratteri, la frase ridotta a titolo.',
    '- nota: il racconto ripulito: punteggiatura, maiuscole, parole spezzate rimesse insieme. Non aggiungere nulla che non sia stato detto, non togliere informazioni. Per le attivita\' da fare, che cosa c\'e\' da fare o da portare, senza la data.',
    '- passo: che cosa si è impegnato a fare lui, in poche parole, vuota se non emerge.',
    '- cliente: il nome dell\'azienda se la frase lo nomina, scegliendolo dall\'elenco qui sotto quando corrisponde, altrimenti come l\'ha detto; vuota se non lo nomina.',
    nomi.length ? 'Elenco dei clienti noti (usalo per correggere i nomi storpiati dalla trascrizione): ' + nomi.join('; ') : '',
    'Non inventare mai date, importi, nomi o impegni. Se un campo non si ricava dalla frase, lascialo vuoto. Scrivi in italiano.'
  ].filter(Boolean).join('\n');

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modelloDi(d), max_tokens: 700, system: istruzioni, messages: [{ role: 'user', content: frase }] })
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
  esito.uso = contoUso(out, modelloDi(d));
  return esito;
}

/* --- 3) sistema il testo di un report: stessa sostanza, forma leggibile --- */
async function sistemaUnGiro(env, testo, insisti, modello, regolePers) {
  const breve = testo.length < 700;
  const regole = [
    'Riscrivi il testo che ricevi in una forma piu chiara e corretta, SENZA cambiarne la sostanza, la struttura e la lunghezza.',
    'NON e un riassunto. Il testo riscritto deve contenere tutto quello che c\'e nell\'originale: se l\'originale ha dieci paragrafi, il tuo ne ha dieci.',
    'E il quaderno di lavoro di un venditore: puo contenere nomi di persone, numeri di telefono e indirizzi dei suoi contatti. Riportali identici, non e materiale da filtrare.',
    'CHE COSA PUOI FARE: correggere refusi, punteggiatura, accordi e parole spezzate dal parlato; togliere ripetizioni e intercalari; sciogliere le frasi contorte; rendere il testo scorrevole.',
    'CHE COSA NON DEVI FARE: riassumere, accorciare, togliere paragrafi o frasi, unire paragrafi diversi, cambiare l\'ordine, cambiare chi parla o a chi si parla, trasformare una lettera o una mail in un resoconto, aggiungere informazioni, cortesie o conclusioni che non ci sono.',
    'Se il testo e una lettera, una mail o un\'offerta (ha un destinatario, un saluto, una firma o dei titoli di sezione), resta tale e quale: tieni intestazione, saluti, titoli, firma e recapiti al loro posto.',
    'Riporta identici: nomi di persone e aziende, numeri di telefono, importi, date, modelli, quantita, condizioni, indirizzi, indirizzi di posta, siti e i segnaposto fra parentesi graffe come {ragione_sociale}.',
    'Se una frase e ambigua, lasciala com\'e invece di interpretarla.',
    breve
      ? 'Il testo e una nota breve: rendila un report scorrevole in prima persona, senza elenchi puntati, conservando tutti i fatti. Non aggiungere formule di apertura o di chiusura.'
      : 'Mantieni la lunghezza e l\'impaginazione: il testo riscritto deve essere lungo quanto quello ricevuto (fra il 90% e il 115%), con gli stessi a capo e le stesse righe vuote fra i paragrafi.',
    'Italiano piano e professionale; mantieni la persona (prima, seconda o terza) e il tono dell\'originale.',
    'Rispondi SOLO con il testo riscritto, senza virgolette, senza preamboli e senza commenti.',
    insisti ? 'IMPORTANTE: la tua risposta precedente non andava bene perche era troppo corta o vuota. Riscrivi TUTTO il testo dall\'inizio alla fine, paragrafo per paragrafo, senza saltarne nessuno, e scrivi solo il testo riscritto dalla prima parola.' : '',
    regolePers || ''
  ].filter(Boolean).join('\n');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modello || MODELLO, max_tokens: 8000, system: regole, messages: [{ role: 'user', content: testo }] })
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
    uso: contoUso(out, modello || MODELLO)
  };
}
/* il testo riscritto non puo essere molto piu corto: sarebbe un riassunto, non una riscrittura */
function troppoCorto(orig, nuovo) {
  if (!nuovo) return false;
  const soglia = orig.length < 700 ? 0.45 : 0.80;
  return nuovo.length < orig.length * soglia;
}
async function sistema(env, testo, modello, regolePers) {
  let a = await sistemaUnGiro(env, testo, false, modello, regolePers);
  if (a.testo && !troppoCorto(testo, a.testo)) return a;
  /* risposta vuota o riassunta: riprovo una volta insistendo, poi dico perche */
  const b = await sistemaUnGiro(env, testo, true, modello, regolePers);
  b.uso = { in: a.uso.in + b.uso.in, out: a.uso.out + b.uso.out, costo: +(a.uso.costo + b.uso.costo).toFixed(6), modello: modello || MODELLO };
  if (b.testo && !troppoCorto(testo, b.testo)) return b;
  if (!b.testo) { b.motivo = 'il modello non ha scritto nulla (stop: ' + b.stop + ', blocchi: ' + (b.tipi || 'nessuno') + ')'; b.testo = ''; return b; }
  b.motivo = 'il modello ha riassunto invece di riscrivere (da ' + testo.length + ' a ' + b.testo.length + ' caratteri): testo lasciato com\'era';
  b.testo = '';
  return b;
}

/* --- 4) riassunto di un cliente: dai suoi dati, in poche frasi, senza inventare nulla --- */
async function riassunto(env, d) {
  const dati = d.dati && typeof d.dati === 'object' ? d.dati : null;
  if (!dati) throw new Error('mancano i dati del cliente');
  const domanda = String(d.domanda || '').slice(0, 300);
  const perVoce = !!d.perVoce;
  const regole = [
    'Sei l\'assistente di un venditore di videosorveglianza. Ricevi in JSON la scheda di un suo cliente: anagrafica, situazione attuale, pratiche aperte, appuntamenti in calendario e gli ultimi report.',
    'Scrivi un riassunto in italiano di quattro o cinque frasi che risponda a: a che punto siamo con questo cliente, che cosa ha chiesto o deciso, che cosa resta da fare e quando, da quanto tempo non lo sentiamo.',
    'REGOLE: usa SOLO quello che c\'e\' nei dati, non inventare mai fatti, date, importi o impegni; se un\'informazione manca dillo in mezza riga invece di riempire il vuoto; niente elenchi puntati, solo frasi; niente formule di apertura o chiusura.',
    'Date in forma italiana (3 novembre 2026). Importi in euro con la virgola per i decimali.',
    perVoce ? 'Il testo verra\' letto ad alta voce mentre la persona guida: frasi brevi, nessuna sigla da sillabare, nessun simbolo, massimo 90 parole.' : '',
    domanda ? 'Rispondi prima di tutto a questa domanda del venditore: ' + domanda : '',
    regolePersona(d)
  ].filter(Boolean).join('\n');
  const modello = modelloDi(d);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modello, max_tokens: 700, system: regole, messages: [{ role: 'user', content: JSON.stringify(dati).slice(0, 60000) }] })
  });
  if (!r.ok) throw new Error('modello: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  const testo = (out.content || []).map(x => (x && typeof x.text === 'string') ? x.text : '').join('\n').trim();
  return { testo: testo, uso: contoUso(out, modello) };
}

/* le regole che la persona si e' scritta nelle impostazioni: valgono per ogni richiesta */
function regolePersona(d) {
  const r = String((d && d.regole) || '').trim().slice(0, 4000);
  if (!r) return '';
  return 'REGOLE DI ANDREA (se le e\' scritte lui, valgono sempre e vengono prima delle preferenze generiche; se una regola contraddice i dati, seguono i dati):\n' + r;
}
/* il nome dell'azienda della scheda, per dirlo al modello senza fargli cercare */
function nomeScheda(dati) {
  try { return String((dati.cliente && dati.cliente.nome) || 'questo cliente'); } catch (e) { return 'questo cliente'; }
}
/* la risposta si legge riga per riga: il parlato e' quello che resta, le righe AZIONE: e CLIENTE: si staccano.
   Se arrivasse comunque del JSON (anche troncato a meta'), si recupera il solo campo «risposta»
   invece di mostrare le graffe alla persona. */
function leggiRisposta(grezzo) {
  let testo = String(grezzo || '').trim(), azione = null, cliente = '', regola = '';
  if (testo.slice(0, 1) === '{') {
    let o = null;
    try { o = JSON.parse(testo); } catch (e) { o = null; }
    if (o && typeof o === 'object') {
      return {
        testo: String(o.risposta || '').trim(),
        azione: (o.azione && typeof o.azione === 'object') ? o.azione : null,
        cliente: String(o.cliente || '').slice(0, 120),
        regola: ''
      };
    }
    /* JSON rotto o tagliato: prendo il testo del campo «risposta» cosi' com'e' */
    const m = testo.match(/"risposta"\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (m) {
      try { testo = JSON.parse('"' + m[1].replace(/\\?$/, '') + '"'); }
      catch (e) { testo = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"'); }
    }
  }
  const righe = testo.split('\n'), tenute = [];
  righe.forEach(r => {
    const a = r.match(/^\s*AZIONE\s*:\s*(\{.*)$/i);
    if (a) {
      try { azione = JSON.parse(a[1]); } catch (e) { azione = null; }
      return;
    }
    const c = r.match(/^\s*CLIENTE\s*:\s*(.+)$/i);
    if (c) { cliente = c[1].trim().slice(0, 120); return; }
    const g = r.match(/^\s*REGOLA\s*:\s*(.+)$/i);
    if (g) { regola = g[1].trim().slice(0, 300); return; }
    tenute.push(r);
  });
  return { testo: tenute.join('\n').trim(), azione: azione, cliente: cliente, regola: regola };
}

/* --- 4-bis) la conversazione: si parla, lui risponde e, se serve, propone di salvare --- */
async function conversa(env, d, frase) {
  const modello = modelloDi(d);
  const dati = d.dati && typeof d.dati === 'object' ? d.dati : null;
  const regole = [
    'Sei l\'assistente di un venditore italiano di videosorveglianza, dentro la sua app dei contatti. State parlando: lui ti parla al microfono e la tua risposta viene letta ad alta voce.',
    'Rispondi in italiano, dandogli del tu, con frasi brevi e punteggiatura vera. Da una a tre frasi. Mai elenchi puntati, mai titoli, mai sigle da sillabare, mai simboli: solo parlato naturale.',
    'Usa soltanto i dati che ricevi. Se una cosa non c\'e\', dillo in mezza riga invece di inventarla: non inventare mai fatti, date, importi, nomi o impegni.',
    'Le date dille a parole (martedi 3 novembre). Gli importi in euro con la virgola per i decimali.',
    'Quando ti chiede di registrare una cosa gia\' fatta (un report) o di mettere in calendario una cosa da fare (visita, telefonata, mail), prepara la proposta nel campo azione e nella risposta chiedigli conferma in una frase sola.',
    'Non proporre un\'azione se non te l\'ha chiesta: alle domande e ai riassunti rispondi e basta, con azione nulla.',
    'Scrivi la risposta come testo normale, senza virgolette e senza JSON attorno.',
    'Se e solo se serve, AGGIUNGI IN FONDO una riga a parte che comincia con AZIONE: seguita da un oggetto JSON su una riga sola, fatto cosi\': AZIONE: {"tipo":"report|visita|telefonata|mail","cliente":"nome","testo":"il testo del report o la nota","quando":"AAAA-MM-GG","ora":"HH:MM","canale":"","tipoAzione":"","richiamo":"AAAA-MM-GG","passo":""}',
    'Se lui passa a parlare di un altro cliente, aggiungi in fondo anche una riga CLIENTE: seguita dal nome come l\'ha detto lui. Queste righe non vengono lette ad alta voce.',
    'Nelle azioni: il report e\' una cosa gia\' fatta e non vuole la data; visita, telefonata e mail vanno in calendario e vogliono quando, e l\'ora se l\'ha detta. Lascia vuoto quello che non sai, non indovinare.',
    'Oggi e\' ' + String(d.oggi || '').slice(0, 10) + '.',
    dati ? 'ATTENZIONE: la scheda qui sotto e\' di ' + nomeScheda(dati) + ' e di nessun altro. Se lui nomina un\'azienda diversa da questa, non hai i suoi dati: dillo subito in una frase, non raccontare quello che leggi qui attribuendolo a un\'altra azienda, e chiedigli di aprire la scheda giusta.' : '',
    'Se lui ti chiede di ricordare una sua preferenza stabile («ricordati che…», «d\'ora in poi…»), aggiungi in fondo una riga REGOLA: seguita dalla regola scritta in una frase, e nella risposta digli che gliela proponi da salvare.',
    regolePersona(d),
    dati ? 'Scheda di ' + nomeScheda(dati) + ', in JSON:\n' + JSON.stringify(dati).slice(0, 60000) : 'Non hai la scheda di nessun cliente: se ti serve, chiedigli di quale cliente sta parlando, e non inventare dati.'
  ].filter(Boolean).join('\n');
  const storia = (Array.isArray(d.storia) ? d.storia : []).slice(-12)
    .map(m => ({ role: (m && m.r === 'a') ? 'assistant' : 'user', content: String((m && m.t) || '').slice(0, 4000) }))
    .filter(m => m.content);
  const messaggi = storia.concat([{ role: 'user', content: String(frase || '').slice(0, 4000) }]);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: modello, max_tokens: 1200, system: regole, messages: messaggi })
  });
  if (!r.ok) throw new Error('modello: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const out = await r.json();
  const grezzo = (out.content || []).map(x => (x && typeof x.text === 'string') ? x.text : '').join('\n').trim();
  const letto = leggiRisposta(grezzo);
  const az = (letto.azione && ['report', 'visita', 'telefonata', 'mail'].indexOf(letto.azione.tipo) >= 0) ? letto.azione : null;
  return { testo: letto.testo, azione: az, cliente: letto.cliente, regola: letto.regola || '', uso: contoUso(out, modello) };
}

/* --- 5) la voce: la frase letta da una voce neurale (OpenAI), con ricaduta sul telefono --- */
const VOCE_MODELLO = 'gpt-4o-mini-tts';
const VOCE_RISERVA = 'tts-1';
const VOCE_PREZZO = 15 / 1000000;   /* dollari per carattere: stima buona per il conto dei consumi */
const VOCE_TONO = 'Parla in italiano, con tono cordiale e naturale, come un collega che guida un amico mentre guida l\'auto. Ritmo tranquillo, pause vere alla punteggiatura, mai robotico. Le domande suonano come domande.';
async function vocePonte(env, testo, nome) {
  if (!env.OPENAI_API_KEY) throw new Error('manca la chiave della voce (OPENAI_API_KEY)');
  const t = String(testo || '').slice(0, 600);
  if (!t) throw new Error('niente da leggere');
  const voce = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'].indexOf(nome) >= 0 ? nome : 'coral';
  async function giro(modello, conTono) {
    const corpo = { model: modello, voice: voce, input: t, response_format: 'mp3' };
    if (conTono) corpo.instructions = VOCE_TONO;
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.OPENAI_API_KEY },
      body: JSON.stringify(corpo)
    });
    if (!r.ok) throw new Error('voce: ' + r.status + ' ' + (await r.text()).slice(0, 160));
    return new Uint8Array(await r.arrayBuffer());
  }
  let buf;
  try { buf = await giro(VOCE_MODELLO, true); }
  catch (e) { buf = await giro(VOCE_RISERVA, false); }
  let b = '';
  const PEZZO = 0x8000;
  for (let i = 0; i < buf.length; i += PEZZO) b += String.fromCharCode.apply(null, buf.subarray(i, i + PEZZO));
  return { audio: btoa(b), caratteri: t.length, costo: +(t.length * VOCE_PREZZO).toFixed(6) };
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
      let frase = String(d.frase || '').slice(0, d.sistema ? 24000 : 4000);

      /* a) la voce: leggi questa frase (non passa dalla trascrizione) */
      if (d.voce) {
        const v = await vocePonte(env, typeof d.voce === 'string' ? d.voce : frase, d.vocenome);
        return risposta({ audio: v.audio, uso: { in: 0, out: 0, costo: v.costo, modello: 'voce', caratteri: v.caratteri } });
      }

      let trascritto = '';
      if (d.audio) {
        trascritto = await trascrivi(env, String(d.audio), d.lingua, d.nomi);
        if (!trascritto) return errore('non ho capito nulla dall’audio', 422);
        frase = trascritto;
      }
      if (!frase && !d.riassunto) return errore('niente da leggere');

      /* a-bis) riassunto di un cliente */
      if (d.riassunto) {
        const r4 = await riassunto(env, d);
        if (!r4.testo) return errore('riassunto non riuscito', 502);
        return risposta({ testo: r4.testo, uso: r4.uso });
      }

      /* a-ter) la conversazione */
      if (d.conversa) {
        const r5 = await conversa(env, d, frase);
        if (!r5.testo) return errore('risposta vuota', 502);
        return risposta({ testo: r5.testo, azione: r5.azione, cliente: r5.cliente, regola: r5.regola, tu: frase, uso: r5.uso });
      }

      /* b) solo trascrizione, senza campi */
      if (d.soloTesto) return risposta({ testo: frase });

      /* c) sistemare il testo di un report già scritto */
      if (d.sistema) { const r3 = await sistema(env, frase, modelloDi(d), regolePersona(d)); if (!r3.testo) return errore(r3.motivo || 'testo non riscritto', 502); return risposta({ testo: r3.testo, uso: r3.uso }); }

      const c = await campi(env, frase, d);
      const TIPI = ['report', 'visita', 'telefonata', 'mail', 'cliente'];
      return risposta({
        testo: frase,
        trascritto: !!trascritto,
        canale: c.canale || '', esito: c.esito || '', richiamo: c.richiamo || '',
        titolo: c.titolo || '', nota: c.nota || frase, passo: c.passo || '', cliente: c.cliente || '',
        tipo: TIPI.indexOf(c.tipo) >= 0 ? c.tipo : 'report',
        quando: /^\d{4}-\d{2}-\d{2}$/.test(c.quando || '') ? c.quando : '',
        ora: /^\d{1,2}:\d{2}$/.test(c.ora || '') ? (c.ora.length === 4 ? '0' + c.ora : c.ora) : '',
        anagrafica: (c.anagrafica && typeof c.anagrafica === 'object') ? c.anagrafica : {},
        uso: c.uso
      });
    } catch (e) {
      return errore(String(e.message || e).slice(0, 300), 502);
    }
  }
};
