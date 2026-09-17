const fs=require('fs');
const src=JSON.parse(fs.readFileSync('quiz_questions_beta.json','utf8'));
const before={0:0,1:0,2:0,3:0};
for(const q of src.questions) before[q.correctAnswerIndex]++;

// --- Italian normalization ---
// Apply only safe, deterministic regex replacements that preserve meaning.
// We log each kind of change for reporting.
const fixCounts={};
const FIXES=[
  // "e'"/"E'" => è/È (apostrofo storto per accento)
  {pat:/\bE'/g, rep:'È', kind:"E' -> È"},
  {pat:/\be'/g, rep:'è', kind:"e' -> è"},
  // "qual e" + (spazio/punct) => "qual è"
  {pat:/\bqual e\b/gi, rep:m=>m[0]==='Q'?'Qual è':'qual è', kind:"qual e -> qual è"},
  // Parole tronche con accento mancante: solo come parola intera \b...\b
  {pat:/\bperche\b/gi, rep:m=>m[0]==='P'?'Perché':'perché', kind:"perche -> perché"},
  {pat:/\bpoiche\b/gi, rep:m=>m[0]==='P'?'Poiché':'poiché', kind:"poiche -> poiché"},
  {pat:/\baffinche\b/gi, rep:m=>m[0]==='A'?'Affinché':'affinché', kind:"affinche -> affinché"},
  {pat:/\bbenche\b/gi, rep:m=>m[0]==='B'?'Benché':'benché', kind:"benche -> benché"},
  {pat:/\bfinche\b/gi, rep:m=>m[0]==='F'?'Finché':'finché', kind:"finche -> finché"},
  {pat:/\bpiu\b/gi, rep:m=>m[0]==='P'?'Più':'più', kind:"piu -> più"},
  {pat:/\bpuo\b/gi, rep:m=>m[0]==='P'?'Può':'può', kind:"puo -> può"},
  {pat:/\bgia\b/gi, rep:m=>m[0]==='G'?'Già':'già', kind:"gia -> già"},
  {pat:/\bcosi\b/gi, rep:m=>m[0]==='C'?'Così':'così', kind:"cosi -> così"},
  // Sostantivi -ita -> -ità
  {pat:/\bcitta\b/gi, rep:m=>m[0]==='C'?'Città':'città', kind:"citta -> città"},
  {pat:/\bautorita\b/gi, rep:m=>m[0]==='A'?'Autorità':'autorità', kind:"autorita -> autorità"},
  {pat:/\bcapacita\b/gi, rep:m=>m[0]==='C'?'Capacità':'capacità', kind:"capacita -> capacità"},
  {pat:/\bqualita\b/gi, rep:m=>m[0]==='Q'?'Qualità':'qualità', kind:"qualita -> qualità"},
  {pat:/\bverita\b/gi, rep:m=>m[0]==='V'?'Verità':'verità', kind:"verita -> verità"},
  {pat:/\brealta\b/gi, rep:m=>m[0]==='R'?'Realtà':'realtà', kind:"realta -> realtà"},
  {pat:/\bsocieta\b/gi, rep:m=>m[0]==='S'?'Società':'società', kind:"societa -> società"},
  {pat:/\bnovita\b/gi, rep:m=>m[0]==='N'?'Novità':'novità', kind:"novita -> novità"},
  {pat:/\bliberta\b/gi, rep:m=>m[0]==='L'?'Libertà':'libertà', kind:"liberta -> libertà"},
  {pat:/\bfelicita\b/gi, rep:m=>m[0]==='F'?'Felicità':'felicità', kind:"felicita -> felicità"},
  {pat:/\beta\b/gi, rep:m=>m[0]==='E'?'Età':'età', kind:"eta -> età"},
];

function normalize(s){
  if(typeof s!=='string') return s;
  let out=s;
  for(const f of FIXES){
    let n=0;
    out=out.replace(f.pat, (m)=>{
      n++;
      return typeof f.rep==='function'? f.rep(m): f.rep;
    });
    if(n){ fixCounts[f.kind]=(fixCounts[f.kind]||0)+n; }
  }
  return out;
}

let questionsTouched=0;
function normalizeQuestion(q){
  let changed=false;
  const fields=['questionText','explanation','sourceBasis','riskNotes','title'];
  for(const f of fields){
    const before=q[f]; const after=normalize(before);
    if(before!==after){ q[f]=after; changed=true; }
  }
  if(Array.isArray(q.answers)){
    q.answers=q.answers.map(a=>{
      const before=a; const after=normalize(a);
      if(before!==after) changed=true;
      return after;
    });
  }
  if(changed) questionsTouched++;
}

// --- Reshuffle answers, update correctAnswerIndex ---
function shuffle(arr){
  const a=arr.slice();
  for(let i=a.length-1;i>0;i--){
    const j=Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}

const after={0:0,1:0,2:0,3:0};
const structuralIssues=[];
const ids=new Set();
for(const q of src.questions){
  // Validate structural pre-reshuffle
  if(!Array.isArray(q.answers) || q.answers.length!==4){ structuralIssues.push(['answers_len',q.questionId]); continue; }
  if(typeof q.correctAnswerIndex!=='number' || q.correctAnswerIndex<0 || q.correctAnswerIndex>3){ structuralIssues.push(['bad_index',q.questionId]); continue; }
  if(q.answers.some(a=>!a || typeof a!=='string' || !a.trim())){ structuralIssues.push(['empty_answer',q.questionId]); continue; }
  // Normalize first
  normalizeQuestion(q);
  // Then reshuffle
  const correctAnswer=q.answers[q.correctAnswerIndex];
  const shuffled=shuffle(q.answers);
  let newIdx=shuffled.indexOf(correctAnswer);
  // If duplicates (shouldn't, but safety): pick first match — verify uniqueness post-norm
  if(newIdx<0){ structuralIssues.push(['lost_correct',q.questionId]); continue; }
  q.answers=shuffled;
  q.correctAnswerIndex=newIdx;
  q.answerOrderShuffled=true;
  after[newIdx]++;
  if(!q.questionId || ids.has(q.questionId)){ structuralIssues.push(['dup_or_missing_id',q.questionId]); }
  ids.add(q.questionId);
}

// Final validation pass
const finalIssues=[];
for(const q of src.questions){
  if(!Array.isArray(q.answers) || q.answers.length!==4) finalIssues.push(['answers_len',q.questionId]);
  if(q.answers && q.answers.some(a=>!a || !a.trim())) finalIssues.push(['empty_answer',q.questionId]);
  if(q.correctAnswerIndex<0||q.correctAnswerIndex>3) finalIssues.push(['bad_index',q.questionId]);
  if(!q.questionId) finalIssues.push(['no_id',q.questionId]);
}

// Subsets
const mediumReview=src.questions.filter(q=>q.confidence==='medium');
const heavySpoiler=src.questions.filter(q=>q.spoilerLevel==='heavy');

// Write outputs
const ts=new Date();
const pad=n=>String(n).padStart(2,'0');
const stamp=`${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;

const importReady={
  generatedAt: stamp,
  source: src.source,
  totalTitles: src.totalTitles,
  totalQuestions: src.questions.length,
  cleanup: {
    answerOrderShuffled: true,
    italianNormalizationApplied: true,
    fixCounts
  },
  questions: src.questions
};
fs.writeFileSync('quiz_questions_import_ready.json', JSON.stringify(importReady,null,2));
fs.writeFileSync('quiz_questions_medium_review.json', JSON.stringify({generatedAt:stamp,count:mediumReview.length,questions:mediumReview},null,2));
fs.writeFileSync('quiz_questions_heavy_spoiler_review.json', JSON.stringify({generatedAt:stamp,count:heavySpoiler.length,questions:heavySpoiler},null,2));

// Distribution stats
const conf={low:0,medium:0,high:0};
const spo={none:0,light:0,medium:0,heavy:0};
const diff={easy:0,medium:0,hard:0};
const cat={};
for(const q of src.questions){
  conf[q.confidence]=(conf[q.confidence]||0)+1;
  spo[q.spoilerLevel]=(spo[q.spoilerLevel]||0)+1;
  diff[q.difficulty]=(diff[q.difficulty]||0)+1;
  cat[q.category]=(cat[q.category]||0)+1;
}

const report={
  generatedAt:stamp,
  total: src.questions.length,
  indexBefore: before,
  indexAfter: after,
  questionsTouchedByNormalization: questionsTouched,
  fixCounts,
  confidence: conf,
  spoiler: spo,
  difficulty: diff,
  category: cat,
  mediumReviewFile:{file:'quiz_questions_medium_review.json', count: mediumReview.length},
  heavySpoilerFile:{file:'quiz_questions_heavy_spoiler_review.json', count: heavySpoiler.length},
  structuralIssuesDuringProcessing: structuralIssues,
  finalIssues
};
fs.writeFileSync('_cleanup_stats.json', JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
