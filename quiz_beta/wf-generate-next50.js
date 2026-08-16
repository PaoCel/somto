export const meta = {
  name: 'quiz-next50-generate',
  description: 'Genera 50 domande quiz IT verificate per ciascuno dei 50 titoli (batch acquisizione)',
  phases: [{ title: 'Generate', detail: '1 agente per titolo: 50 domande, verifica fatti, scrive q_<rank>.json' }],
}

const TITLES = [{"rank":81,"cluster":"anime","title":"One Piece","catalogName":"One Piece","mediaType":"tv","tmdbId":"37854","titleId":"tmdb_tv_37854"},{"rank":82,"cluster":"anime","title":"Naruto","catalogName":"Naruto Shippuden","mediaType":"tv","tmdbId":"31910","titleId":"tmdb_tv_31910"},{"rank":83,"cluster":"anime","title":"L'attacco dei giganti","catalogName":"L'attacco dei giganti","mediaType":"tv","tmdbId":"1429","titleId":"tmdb_tv_1429"},{"rank":84,"cluster":"anime","title":"Demon Slayer","catalogName":"Demon Slayer","mediaType":"tv","tmdbId":"85937","titleId":"tmdb_tv_85937"},{"rank":85,"cluster":"anime","title":"Death Note","catalogName":"Death Note","mediaType":"tv","tmdbId":"13916","titleId":"tmdb_tv_13916"},{"rank":86,"cluster":"anime","title":"Dragon Ball Z","catalogName":"Dragon Ball Z","mediaType":"tv","tmdbId":"12971","titleId":"tmdb_tv_12971"},{"rank":87,"cluster":"anime","title":"Jujutsu Kaisen","catalogName":"Jujutsu Kaisen","mediaType":"tv","tmdbId":"95479","titleId":"tmdb_tv_95479"},{"rank":88,"cluster":"anime","title":"My Hero Academia","catalogName":"My Hero Academia","mediaType":"tv","tmdbId":"65930","titleId":"tmdb_tv_65930"},{"rank":89,"cluster":"italiano","title":"Mare Fuori","catalogName":"Mare Fuori","mediaType":"tv","tmdbId":"110283","titleId":"mare-fuori"},{"rank":90,"cluster":"italiano","title":"Gomorra - La serie","catalogName":"Gomorra - La Serie","mediaType":"tv","tmdbId":"61068","titleId":"tmdb_tv_61068"},{"rank":91,"cluster":"italiano","title":"SKAM Italia","catalogName":"SKAM Italia","mediaType":"tv","tmdbId":"77826","titleId":"tmdb_tv_77826"},{"rank":92,"cluster":"italiano","title":"Romanzo Criminale - La serie","catalogName":"Romanzo Criminale - La serie","mediaType":"tv","tmdbId":"41597","titleId":"tmdb_tv_41597"},{"rank":93,"cluster":"italiano","title":"Il commissario Montalbano","catalogName":"Il commissario Montalbano","mediaType":"tv","tmdbId":"37290","titleId":"tmdb_tv_37290"},{"rank":94,"cluster":"italiano","title":"Perfetti sconosciuti","catalogName":"Perfetti sconosciuti","mediaType":"movie","tmdbId":"381341","titleId":"tmdb_movie_381341"},{"rank":95,"cluster":"italiano","title":"Tolo Tolo","catalogName":"Tolo tolo","mediaType":"movie","tmdbId":"","titleId":"tolo-tolo-2020"},{"rank":96,"cluster":"italiano","title":"Tre metri sopra il cielo","catalogName":"Tre metri sopra il cielo","mediaType":"movie","tmdbId":"56903","titleId":"tmdb_movie_56903"},{"rank":97,"cluster":"italiano","title":"Smetto quando voglio","catalogName":"Smetto quando voglio","mediaType":"movie","tmdbId":"250219","titleId":"tmdb_movie_250219"},{"rank":98,"cluster":"tv_global","title":"Il Trono di Spade","catalogName":"Il Trono di Spade","mediaType":"tv","tmdbId":"1399","titleId":"il-trono-di-spade"},{"rank":99,"cluster":"tv_global","title":"House of the Dragon","catalogName":"House of the Dragon","mediaType":"tv","tmdbId":"94997","titleId":"tmdb_tv_94997"},{"rank":100,"cluster":"tv_global","title":"The Office (US)","catalogName":"The Office (US)","mediaType":"tv","tmdbId":"2316","titleId":"tmdb_tv_2316"},{"rank":101,"cluster":"tv_global","title":"Friends","catalogName":"Friends","mediaType":"tv","tmdbId":"1668","titleId":"friends-1994"},{"rank":102,"cluster":"tv_global","title":"Peaky Blinders","catalogName":"Peaky Blinders","mediaType":"tv","tmdbId":"60574","titleId":"tmdb_tv_60574"},{"rank":103,"cluster":"tv_global","title":"The Witcher","catalogName":"The Witcher","mediaType":"tv","tmdbId":"71912","titleId":"tmdb_tv_71912"},{"rank":104,"cluster":"tv_global","title":"Mercoledì","catalogName":"Mercoledì","mediaType":"tv","tmdbId":"119051","titleId":"mercoledi"},{"rank":105,"cluster":"tv_global","title":"Lupin","catalogName":"Lupin","mediaType":"tv","tmdbId":"96677","titleId":"lupin"},{"rank":106,"cluster":"tv_global","title":"The Last of Us","catalogName":"The Last of Us","mediaType":"tv","tmdbId":"100088","titleId":"tmdb_tv_100088"},{"rank":107,"cluster":"tv_global","title":"Dark","catalogName":"Dark","mediaType":"tv","tmdbId":"70523","titleId":"dark-na-tv"},{"rank":108,"cluster":"tv_global","title":"The Boys","catalogName":"The Boys","mediaType":"tv","tmdbId":"76479","titleId":"tmdb_tv_76479"},{"rank":109,"cluster":"tv_global","title":"Lost","catalogName":"Lost","mediaType":"tv","tmdbId":"4607","titleId":"lost"},{"rank":110,"cluster":"tv_global","title":"Narcos","catalogName":"Narcos","mediaType":"tv","tmdbId":"63351","titleId":"tmdb_tv_63351"},{"rank":111,"cluster":"film_cult","title":"Il Signore degli Anelli: La Compagnia dell'Anello","catalogName":"Il Signore degli Anelli - La Compagnia dell'Anello","mediaType":"movie","tmdbId":"120","titleId":"tmdb_movie_120"},{"rank":112,"cluster":"film_cult","title":"Il Signore degli Anelli: Il ritorno del re","catalogName":"Il Signore degli Anelli - Il ritorno del re","mediaType":"movie","tmdbId":"122","titleId":"tmdb_movie_122"},{"rank":113,"cluster":"film_cult","title":"Star Wars: Una nuova speranza","catalogName":"Guerre stellari","mediaType":"movie","tmdbId":"11","titleId":"tmdb_movie_11"},{"rank":114,"cluster":"film_cult","title":"Pirati dei Caraibi: La maledizione della prima luna","catalogName":"La maledizione della prima luna","mediaType":"movie","tmdbId":"22","titleId":"tmdb_movie_22"},{"rank":115,"cluster":"film_cult","title":"Jurassic Park","catalogName":"Jurassic Park","mediaType":"movie","tmdbId":"329","titleId":"tmdb_movie_329"},{"rank":116,"cluster":"film_cult","title":"Il Padrino","catalogName":"Il padrino","mediaType":"movie","tmdbId":"238","titleId":"tmdb_movie_238"},{"rank":117,"cluster":"film_cult","title":"Pulp Fiction","catalogName":"Pulp Fiction","mediaType":"movie","tmdbId":"680","titleId":"tmdb_movie_680"},{"rank":118,"cluster":"film_cult","title":"Fight Club","catalogName":"Fight Club","mediaType":"movie","tmdbId":"550","titleId":"tmdb_movie_550"},{"rank":119,"cluster":"film_cult","title":"Forrest Gump","catalogName":"Forrest Gump","mediaType":"movie","tmdbId":"13","titleId":"tmdb_movie_13"},{"rank":120,"cluster":"film_cult","title":"Matrix","catalogName":"Matrix","mediaType":"movie","tmdbId":"603","titleId":"tmdb_movie_603"},{"rank":121,"cluster":"film_cult","title":"Titanic","catalogName":"Titanic","mediaType":"movie","tmdbId":"597","titleId":"tmdb_movie_597"},{"rank":122,"cluster":"film_cult","title":"Il Gladiatore","catalogName":"Il gladiatore","mediaType":"movie","tmdbId":"98","titleId":"tmdb_movie_98"},{"rank":123,"cluster":"film_cult","title":"Joker","catalogName":"Joker","mediaType":"movie","tmdbId":"475557","titleId":"tmdb_movie_475557"},{"rank":124,"cluster":"film_cult","title":"Il cavaliere oscuro","catalogName":"Il cavaliere oscuro","mediaType":"movie","tmdbId":"155","titleId":"tmdb_movie_155"},{"rank":125,"cluster":"film_cult","title":"Il Re Leone","catalogName":"Il re leone","mediaType":"movie","tmdbId":"8587","titleId":"tmdb_movie_8587"},{"rank":126,"cluster":"film_cult","title":"Ritorno al futuro","catalogName":"Ritorno al futuro","mediaType":"movie","tmdbId":"105","titleId":"tmdb_movie_105"},{"rank":127,"cluster":"film_cult","title":"Le ali della libertà","catalogName":"Le ali della libertà","mediaType":"movie","tmdbId":"278","titleId":"tmdb_movie_278"},{"rank":128,"cluster":"film_cult","title":"Django Unchained","catalogName":"Django Unchained","mediaType":"movie","tmdbId":"68718","titleId":"tmdb_movie_68718"},{"rank":129,"cluster":"film_cult","title":"Hunger Games","catalogName":"Hunger Games","mediaType":"movie","tmdbId":"70160","titleId":"hunger-games-2012"},{"rank":130,"cluster":"film_cult","title":"Fast & Furious","catalogName":"Fast & Furious","mediaType":"movie","tmdbId":"9799","titleId":"tmdb_movie_9799"}];
const OUTDIR = process.cwd() + "/quiz_beta/next50";

const SUMMARY = {
  type: 'object',
  additionalProperties: false,
  required: ['rank','title','count','heavy','mediumConfidence','lowConfidence','path','ok'],
  properties: {
    rank: { type: 'number' },
    title: { type: 'string' },
    count: { type: 'number', description: 'numero domande scritte nel file (atteso 50)' },
    heavy: { type: 'number', description: 'quante spoilerLevel=heavy' },
    mediumConfidence: { type: 'number' },
    lowConfidence: { type: 'number' },
    path: { type: 'string' },
    ok: { type: 'boolean', description: 'true se 50 domande valide scritte' },
    notes: { type: 'string' },
  },
};

function promptFor(t) {
  const isTv = t.mediaType === 'tv';
  const path = OUTDIR + '/q_' + t.rank + '.json';
  return [
    'Sei un autore esperto di quiz in ITALIANO su film e serie TV. Devi creare un quiz di alta qualita per UN titolo.',
    '',
    'TITOLO: "' + t.title + '"  (nome catalogo: "' + t.catalogName + '")',
    'Tipo: ' + (isTv ? 'serie TV' : 'film') + ' | TMDB id: ' + t.tmdbId + ' | titleId Somto: ' + t.titleId + ' | rank: ' + t.rank,
    '',
    'OBIETTIVO: genera ESATTAMENTE 50 domande a risposta multipla (4 opzioni, 1 corretta), in italiano, fattualmente CORRETTE.',
    '',
    'ANTI-ALLUCINAZIONE (critico): includi solo fatti del canone verificabili. Per qualsiasi dato specifico (nomi, anni, numeri, citazioni, dettagli di scena) di cui NON sei certo al 100%, VERIFICA con WebSearch/WebFetch (TMDB, Wikipedia IT, fonti ufficiali) PRIMA di scrivere. Se resta un dubbio: abbassa confidence a "medium" o "low" e compila riskNotes. NON inventare MAI dettagli. Meglio una domanda solida e nota che una incerta.',
    '',
    'DISTRIBUZIONE per le 50 domande:',
    '- difficolta: ~15 easy, ~22 medium, ~13 hard',
    '- categorie (spalmare): anagraphic, character, plot, relationship, motivation, object, scene, consequence, trivia, quote_paraphrase, chronology' + (isTv ? ', episode (per le serie usa anche domande per stagione/episodio e distribuisci su piu stagioni)' : ' (NIENTE categoria episode per i film)'),
    '- spoilerLevel onesto: "none"/"light" per fatti generali; "medium" per snodi di trama; "heavy" SOLO per finali/morti/colpi di scena chiave. Etichetta SEMPRE heavy i veri spoiler.',
    '- distrattori plausibili ma inequivocabilmente errati; evita ambiguita e doppie risposte corrette.',
    '- niente domande duplicate (questionText distinti).',
    '',
    'SCHEMA per OGNI domanda (oggetto JSON, questi campi esatti):',
    '{',
    '  "questionId": "q_' + t.rank + '_<n>"  (n da 1 a 50),',
    '  "titleId": "' + t.titleId + '",',
    '  "tmdbId": "' + t.tmdbId + '",',
    '  "mediaType": "' + t.mediaType + '",',
    '  "title": "' + t.title + '",',
    '  "questionText": "<domanda in italiano>",',
    '  "answers": ["<opzione1>","<opzione2>","<opzione3>","<opzione4>"],',
    '  "correctAnswerIndex": <0-3>,',
    '  "explanation": "<breve spiegazione della risposta corretta, in italiano>",',
    '  "difficulty": "easy|medium|hard",',
    '  "category": "<una delle categorie sopra>",',
    '  "spoilerLevel": "none|light|medium|heavy",',
    '  "confidence": "high|medium|low",',
    '  "sourceLevel": "GREEN|YELLOW|RED"  (GREEN = fatto pubblico solido; YELLOW = verificato ma di nicchia; RED = incerto),',
    '  "sourceBasis": "<da dove viene il fatto, es: TMDB, trama nota, episodio SxEy>",',
    '  "riskNotes": "<vuoto, o nota se confidence<high>",',
    '  "status": "beta_pending_review",',
    '  "createdBy": "ai",',
    '  "language": "it",',
    '  "answerOrderShuffled": false',
    '}',
    '',
    'PASSO FINALE DI AUTOCONTROLLO: prima di scrivere, rileggi le 50 domande e correggi/declassa quelle di cui non sei certo.',
    '',
    'OUTPUT: usa lo strumento Write per scrivere un ARRAY JSON di ESATTAMENTE 50 oggetti domanda nel file:',
    path,
    '(solo l\'array JSON, nessun testo attorno). Poi restituisci il summary strutturato (count = domande scritte, heavy = quante heavy, mediumConfidence/lowConfidence = conteggi, path = il path, ok = true se 50 valide).',
  ].join('\n');
}

phase('Generate')
log('Genero 50 domande x 50 titoli (2500). 1 agente per titolo, scrive q_<rank>.json.')
const results = await parallel(TITLES.map(t => () =>
  agent(promptFor(t), { label: 'gen:' + t.rank + ' ' + t.title, phase: 'Generate', schema: SUMMARY, agentType: 'general-purpose' })
))
const ok = results.filter(Boolean)
const total = ok.reduce((s,r)=>s+(r.count||0),0)
log('Completati ' + ok.length + '/' + TITLES.length + ' titoli, ~' + total + ' domande.')
return { titlesDone: ok.length, totalQuestions: total, perTitle: ok }
