export const meta = {
  name: 'quiz-next50-resume-sonnet',
  description: 'Resume: genera 50 domande quiz IT per i titoli mancanti del batch (Sonnet)',
  phases: [{ title: 'Generate', detail: 'titoli mancanti, 50 domande ciascuno, modello Sonnet', model: 'sonnet' }],
}

const TITLES = [{"rank":112,"cluster":"film_cult","title":"Il Signore degli Anelli: Il ritorno del re","catalogName":"Il Signore degli Anelli - Il ritorno del re","mediaType":"movie","tmdbId":"122","titleId":"tmdb_movie_122"},{"rank":113,"cluster":"film_cult","title":"Star Wars: Una nuova speranza","catalogName":"Guerre stellari","mediaType":"movie","tmdbId":"11","titleId":"tmdb_movie_11"},{"rank":114,"cluster":"film_cult","title":"Pirati dei Caraibi: La maledizione della prima luna","catalogName":"La maledizione della prima luna","mediaType":"movie","tmdbId":"22","titleId":"tmdb_movie_22"},{"rank":115,"cluster":"film_cult","title":"Jurassic Park","catalogName":"Jurassic Park","mediaType":"movie","tmdbId":"329","titleId":"tmdb_movie_329"},{"rank":116,"cluster":"film_cult","title":"Il Padrino","catalogName":"Il padrino","mediaType":"movie","tmdbId":"238","titleId":"tmdb_movie_238"},{"rank":117,"cluster":"film_cult","title":"Pulp Fiction","catalogName":"Pulp Fiction","mediaType":"movie","tmdbId":"680","titleId":"tmdb_movie_680"},{"rank":118,"cluster":"film_cult","title":"Fight Club","catalogName":"Fight Club","mediaType":"movie","tmdbId":"550","titleId":"tmdb_movie_550"},{"rank":119,"cluster":"film_cult","title":"Forrest Gump","catalogName":"Forrest Gump","mediaType":"movie","tmdbId":"13","titleId":"tmdb_movie_13"},{"rank":120,"cluster":"film_cult","title":"Matrix","catalogName":"Matrix","mediaType":"movie","tmdbId":"603","titleId":"tmdb_movie_603"},{"rank":121,"cluster":"film_cult","title":"Titanic","catalogName":"Titanic","mediaType":"movie","tmdbId":"597","titleId":"tmdb_movie_597"},{"rank":122,"cluster":"film_cult","title":"Il Gladiatore","catalogName":"Il gladiatore","mediaType":"movie","tmdbId":"98","titleId":"tmdb_movie_98"},{"rank":123,"cluster":"film_cult","title":"Joker","catalogName":"Joker","mediaType":"movie","tmdbId":"475557","titleId":"tmdb_movie_475557"},{"rank":124,"cluster":"film_cult","title":"Il cavaliere oscuro","catalogName":"Il cavaliere oscuro","mediaType":"movie","tmdbId":"155","titleId":"tmdb_movie_155"},{"rank":125,"cluster":"film_cult","title":"Il Re Leone","catalogName":"Il re leone","mediaType":"movie","tmdbId":"8587","titleId":"tmdb_movie_8587"},{"rank":126,"cluster":"film_cult","title":"Ritorno al futuro","catalogName":"Ritorno al futuro","mediaType":"movie","tmdbId":"105","titleId":"tmdb_movie_105"},{"rank":127,"cluster":"film_cult","title":"Le ali della libertà","catalogName":"Le ali della libertà","mediaType":"movie","tmdbId":"278","titleId":"tmdb_movie_278"},{"rank":128,"cluster":"film_cult","title":"Django Unchained","catalogName":"Django Unchained","mediaType":"movie","tmdbId":"68718","titleId":"tmdb_movie_68718"},{"rank":129,"cluster":"film_cult","title":"Hunger Games","catalogName":"Hunger Games","mediaType":"movie","tmdbId":"70160","titleId":"hunger-games-2012"},{"rank":130,"cluster":"film_cult","title":"Fast & Furious","catalogName":"Fast & Furious","mediaType":"movie","tmdbId":"9799","titleId":"tmdb_movie_9799"}];
const OUTDIR = process.cwd() + "/quiz_beta/next50";

const SUMMARY = {
  type: 'object', additionalProperties: false,
  required: ['rank','title','count','heavy','mediumConfidence','lowConfidence','path','ok'],
  properties: {
    rank: { type: 'number' }, title: { type: 'string' }, count: { type: 'number' },
    heavy: { type: 'number' }, mediumConfidence: { type: 'number' }, lowConfidence: { type: 'number' },
    path: { type: 'string' }, ok: { type: 'boolean' }, notes: { type: 'string' },
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
    '  "sourceLevel": "GREEN|YELLOW|RED",',
    '  "sourceBasis": "<da dove viene il fatto>",',
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
    '(solo l\'array JSON, nessun testo attorno). Poi restituisci il summary strutturato.',
  ].join('\n');
}

phase('Generate')
log('Resume Sonnet: ' + TITLES.length + ' titoli mancanti, 50 domande ciascuno.')
const results = await parallel(TITLES.map(t => () =>
  agent(promptFor(t), { label: 'gen:' + t.rank + ' ' + t.title, phase: 'Generate', schema: SUMMARY, agentType: 'general-purpose', model: 'sonnet' })
))
const ok = results.filter(Boolean)
const total = ok.reduce((s,r)=>s+(r.count||0),0)
log('Completati ' + ok.length + '/' + TITLES.length + ' titoli, ~' + total + ' domande.')
return { titlesDone: ok.length, totalQuestions: total, perTitle: ok }
