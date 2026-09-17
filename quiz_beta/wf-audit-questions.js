export const meta = {
  name: 'quiz-audit-next50',
  description: 'Audit qualità avversariale delle 2500 domande next50 (fact-check per titolo)',
  phases: [{ title: 'Audit' }],
}
const DIR = process.cwd() + "/quiz_beta/next50";
const TITLES = [{"rank":81,"title":"One Piece","mediaType":"tv","tmdbId":"37854"},{"rank":82,"title":"Naruto","mediaType":"tv","tmdbId":"31910"},{"rank":83,"title":"L'attacco dei giganti","mediaType":"tv","tmdbId":"1429"},{"rank":84,"title":"Demon Slayer","mediaType":"tv","tmdbId":"85937"},{"rank":85,"title":"Death Note","mediaType":"tv","tmdbId":"13916"},{"rank":86,"title":"Dragon Ball Z","mediaType":"tv","tmdbId":"12971"},{"rank":87,"title":"Jujutsu Kaisen","mediaType":"tv","tmdbId":"95479"},{"rank":88,"title":"My Hero Academia","mediaType":"tv","tmdbId":"65930"},{"rank":89,"title":"Mare Fuori","mediaType":"tv","tmdbId":"110283"},{"rank":90,"title":"Gomorra - La serie","mediaType":"tv","tmdbId":"61068"},{"rank":91,"title":"SKAM Italia","mediaType":"tv","tmdbId":"77826"},{"rank":92,"title":"Romanzo Criminale - La serie","mediaType":"tv","tmdbId":"41597"},{"rank":93,"title":"Il commissario Montalbano","mediaType":"tv","tmdbId":"37290"},{"rank":94,"title":"Perfetti sconosciuti","mediaType":"movie","tmdbId":"381341"},{"rank":95,"title":"Tolo Tolo","mediaType":"movie","tmdbId":""},{"rank":96,"title":"Tre metri sopra il cielo","mediaType":"movie","tmdbId":"56903"},{"rank":97,"title":"Smetto quando voglio","mediaType":"movie","tmdbId":"250219"},{"rank":98,"title":"Il Trono di Spade","mediaType":"tv","tmdbId":"1399"},{"rank":99,"title":"House of the Dragon","mediaType":"tv","tmdbId":"94997"},{"rank":100,"title":"The Office (US)","mediaType":"tv","tmdbId":"2316"},{"rank":101,"title":"Friends","mediaType":"tv","tmdbId":"1668"},{"rank":102,"title":"Peaky Blinders","mediaType":"tv","tmdbId":"60574"},{"rank":103,"title":"The Witcher","mediaType":"tv","tmdbId":"71912"},{"rank":104,"title":"Mercoledì","mediaType":"tv","tmdbId":"119051"},{"rank":105,"title":"Lupin","mediaType":"tv","tmdbId":"96677"},{"rank":106,"title":"The Last of Us","mediaType":"tv","tmdbId":"100088"},{"rank":107,"title":"Dark","mediaType":"tv","tmdbId":"70523"},{"rank":108,"title":"The Boys","mediaType":"tv","tmdbId":"76479"},{"rank":109,"title":"Lost","mediaType":"tv","tmdbId":"4607"},{"rank":110,"title":"Narcos","mediaType":"tv","tmdbId":"63351"},{"rank":111,"title":"Il Signore degli Anelli: La Compagnia dell'Anello","mediaType":"movie","tmdbId":"120"},{"rank":112,"title":"Il Signore degli Anelli: Il ritorno del re","mediaType":"movie","tmdbId":"122"},{"rank":113,"title":"Star Wars: Una nuova speranza","mediaType":"movie","tmdbId":"11"},{"rank":114,"title":"Pirati dei Caraibi: La maledizione della prima luna","mediaType":"movie","tmdbId":"22"},{"rank":115,"title":"Jurassic Park","mediaType":"movie","tmdbId":"329"},{"rank":116,"title":"Il Padrino","mediaType":"movie","tmdbId":"238"},{"rank":117,"title":"Pulp Fiction","mediaType":"movie","tmdbId":"680"},{"rank":118,"title":"Fight Club","mediaType":"movie","tmdbId":"550"},{"rank":119,"title":"Forrest Gump","mediaType":"movie","tmdbId":"13"},{"rank":120,"title":"Matrix","mediaType":"movie","tmdbId":"603"},{"rank":121,"title":"Titanic","mediaType":"movie","tmdbId":"597"},{"rank":122,"title":"Il Gladiatore","mediaType":"movie","tmdbId":"98"},{"rank":123,"title":"Joker","mediaType":"movie","tmdbId":"475557"},{"rank":124,"title":"Il cavaliere oscuro","mediaType":"movie","tmdbId":"155"},{"rank":125,"title":"Il Re Leone","mediaType":"movie","tmdbId":"8587"},{"rank":126,"title":"Ritorno al futuro","mediaType":"movie","tmdbId":"105"},{"rank":127,"title":"Le ali della libertà","mediaType":"movie","tmdbId":"278"},{"rank":128,"title":"Django Unchained","mediaType":"movie","tmdbId":"68718"},{"rank":129,"title":"Hunger Games","mediaType":"movie","tmdbId":"70160"},{"rank":130,"title":"Fast & Furious","mediaType":"movie","tmdbId":"9799"}];

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['rank','title','checked','okCount','issues'],
  properties: {
    rank: { type: 'number' }, title: { type: 'string' },
    checked: { type: 'number' }, okCount: { type: 'number' },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['questionId','severity','problem'],
      properties: {
        questionId: { type: 'string' },
        severity: { type: 'string', enum: ['critical','minor'] },
        problem: { type: 'string', description: 'cosa non va nella domanda' },
        fix: { type: 'string', description: 'correzione consigliata' },
        correctIndexShouldBe: { type: 'number', description: 'indice corretto se la risposta segnata e sbagliata, altrimenti -1' },
      } } },
  },
};

function promptFor(t){
  const fp = DIR + '/q_' + t.rank + '.json';
  return [
    'Sei un fact-checker severo di quiz su film/serie in italiano. Controlla la QUALITA FATTUALE delle domande di UN titolo.',
    'TITOLO: "' + t.title + '" (' + t.mediaType + ', TMDB ' + t.tmdbId + ').',
    'Leggi il file: ' + fp + ' (array di 50 domande con questionId, questionText, answers[4], correctAnswerIndex, explanation, difficulty, spoilerLevel, confidence).',
    'Per OGNI domanda verifica: (1) la risposta segnata (correctAnswerIndex) e davvero corretta? (2) i distrattori sono inequivocabilmente errati (no doppie risposte giuste)? (3) il fatto e vero (verifica via WebSearch/WebFetch i dettagli incerti: nomi, anni, numeri, eventi)? (4) spoilerLevel coerente (finali/morti/twist = heavy)?',
    'Segnala SOLO le domande con problemi. severity "critical" = risposta sbagliata / fatto falso / doppia risposta giusta; "minor" = spoiler mislabel, distrattore debole, imprecisione lieve. Se la risposta segnata e sbagliata, indica correctIndexShouldBe (0-3), altrimenti -1.',
    'Restituisci: rank, title, checked (=50), okCount (=50 meno le issue), issues[]. Sii rigoroso ma non inventare problemi inesistenti: una domanda corretta non va segnalata.',
  ].join('\n');
}

phase('Audit')
log('Audit fact-check: ' + TITLES.length + ' titoli x 50 domande.')
const results = await parallel(TITLES.map(t => () =>
  agent(promptFor(t), { label: 'audit:' + t.rank + ' ' + t.title, phase: 'Audit', schema: SCHEMA, agentType: 'general-purpose', model: 'sonnet' })
))
const ok = results.filter(Boolean)
const totalIssues = ok.reduce((s,r)=>s+(r.issues?r.issues.length:0),0)
const critical = ok.reduce((s,r)=>s+(r.issues?r.issues.filter(i=>i.severity==='critical').length:0),0)
log('Audit done. Titoli: ' + ok.length + ' | issue totali: ' + totalIssues + ' | critical: ' + critical)
return { titles: ok.length, totalIssues, critical, perTitle: ok }
