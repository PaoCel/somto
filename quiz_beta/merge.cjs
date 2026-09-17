const fs=require('fs');
const batches=['batch_1.json','batch_2.json','batch_3.json','batch_4.json','batch_5.json'];
const all=[];
for(const b of batches){
  const d=JSON.parse(fs.readFileSync(b,'utf8'));
  all.push(...d);
}
// Validation
const issues=[];
const ids=new Set();
const dupQTextByTitle={}; // titleId -> Map questionText -> count
for(const q of all){
  if(!q.questionId || ids.has(q.questionId)) issues.push(['dup_or_missing_id', q.questionId]);
  ids.add(q.questionId);
  if(!Array.isArray(q.answers) || q.answers.length!==4) issues.push(['answers_len', q.questionId]);
  if(q.answers && q.answers.some(a=>!a || typeof a!=='string' || !a.trim())) issues.push(['empty_answer', q.questionId]);
  if(typeof q.correctAnswerIndex!=='number' || q.correctAnswerIndex<0 || q.correctAnswerIndex>3) issues.push(['bad_index', q.questionId, q.correctAnswerIndex]);
  if(!q.questionText) issues.push(['empty_qtext', q.questionId]);
  if(!q.language || q.language!=='it') issues.push(['bad_lang', q.questionId]);
  // duplicates by normalized text within same title
  const tid=q.titleId||'';
  const norm=(q.questionText||'').toLowerCase().replace(/[^a-z0-9àèéìòù ]/g,'').replace(/\s+/g,' ').trim();
  dupQTextByTitle[tid]=dupQTextByTitle[tid]||new Map();
  const m=dupQTextByTitle[tid];
  m.set(norm, (m.get(norm)||0)+1);
}
// flag near-dup (same normalized text)
for(const [tid,m] of Object.entries(dupQTextByTitle)){
  for(const [k,v] of m){
    if(v>1) issues.push(['near_dup_text', tid, k.slice(0,80), 'x'+v]);
  }
}
// stats
const byTitle={};
const byConfidence={low:0,medium:0,high:0};
const bySource={GREEN:0,YELLOW:0,RED:0};
const byDifficulty={easy:0,medium:0,hard:0};
const bySpoiler={none:0,light:0,medium:0,heavy:0};
const byCategory={};
const idxDist={0:0,1:0,2:0,3:0};
for(const q of all){
  byTitle[q.title]=(byTitle[q.title]||0)+1;
  byConfidence[q.confidence]=(byConfidence[q.confidence]||0)+1;
  bySource[q.sourceLevel]=(bySource[q.sourceLevel]||0)+1;
  byDifficulty[q.difficulty]=(byDifficulty[q.difficulty]||0)+1;
  bySpoiler[q.spoilerLevel]=(bySpoiler[q.spoilerLevel]||0)+1;
  byCategory[q.category]=(byCategory[q.category]||0)+1;
  idxDist[q.correctAnswerIndex]=(idxDist[q.correctAnswerIndex]||0)+1;
}
console.log('TOTAL:',all.length);
console.log('by title:',JSON.stringify(byTitle,null,2));
console.log('confidence:',byConfidence,'source:',bySource);
console.log('difficulty:',byDifficulty,'spoiler:',bySpoiler);
console.log('categories:',byCategory);
console.log('correctIndexDist:',idxDist);
console.log('issues count:',issues.length);
if(issues.length) console.log(issues.slice(0,30));
const ts=new Date();
const pad=n=>String(n).padStart(2,'0');
const stamp=`${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())} ${pad(ts.getHours())}:${pad(ts.getMinutes())}:${pad(ts.getSeconds())}`;
const out={
  generatedAt:stamp,
  source:"Somto DB top 20 watched titles",
  totalTitles:20,
  totalQuestions:all.length,
  questions:all
};
fs.writeFileSync('quiz_questions_beta.json', JSON.stringify(out,null,2));
fs.writeFileSync('_validation_stats.json', JSON.stringify({total:all.length,byTitle,byConfidence,bySource,byDifficulty,bySpoiler,byCategory,idxDist,issues},null,2));
console.log('WROTE quiz_questions_beta.json');
