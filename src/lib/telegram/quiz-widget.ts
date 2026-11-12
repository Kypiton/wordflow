import "server-only";

import type { QuizContent, SessionMode } from "./quiz-domain";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

/** Fixed Telegram widget HTML. Correct answers never enter the initial markup. */
export function quizWidgetHtml(sessionId: string, content: QuizContent, context: { mode: SessionMode; total: number; position: number } = { mode: "LEARN", total: 10, position: 0 }): string {
  if (!/^[a-f0-9]{24}$/.test(sessionId)) throw new Error("Invalid quiz session.");
  if (!content || !Array.isArray(content.options) || (content.kind === "self" ? content.options.length !== 0 : content.options.length !== 4) ||
    !content.term || content.term.length > 80 || (content.kind !== "self" && !content.partOfSpeech) ||
    content.partOfSpeech.length > 40 || content.options.some(option => !option || option.length > 80)) {
    throw new Error("Invalid quiz content.");
  }
  if (!["LEARN", "REVIEW"].includes(context.mode) || !Number.isInteger(context.total) || context.total < 1 || context.total > 10 ||
      !Number.isInteger(context.position) || context.position < 0 || context.position >= context.total) throw new Error("Invalid session context.");
  const options = (content.kind === "self" ? ["", "", "", ""] : content.options).map((option, index) =>
    `<button class="option" ${content.kind === "self" ? "hidden" : ""} data-choice="${index}"><span class="letter">${"ABCD"[index]}</span><span class="value">${escapeHtml(option)}</span></button>`).join("");
  return `<style>
*{box-sizing:border-box}body{margin:0;padding:0;background:#f6f3fb;color:#302642;font:15px/1.4 system-ui,sans-serif}.card{padding:20px 20px max(20px,env(safe-area-inset-bottom));max-width:600px}.top{display:flex;justify-content:space-between;align-items:center;color:#76628f;font-size:11px;letter-spacing:1.2px;font-weight:700}.dot{width:7px;height:7px;border-radius:50%;background:#9a7cc4;display:inline-block;margin-right:6px}.track{height:5px;background:#e7dfef;border-radius:9px;margin-top:13px;overflow:hidden}.fill{height:100%;width:10%;background:#9673c9;border-radius:9px}h1{font-size:30px;line-height:1.17;letter-spacing:-.8px;margin:21px 0 5px}p{margin:0}.hint{color:#7a6d89;font-size:13px}.answers{display:grid;gap:8px;margin:17px 0 12px}button{font:inherit;cursor:pointer;touch-action:auto}.option{display:flex;align-items:center;gap:12px;width:100%;min-height:44px;text-align:left;border:1px solid #e3daef;border-radius:12px;padding:9px 12px;background:#fff;color:#403250}.letter{font-size:11px;color:#8a729f;font-weight:700}.option[disabled]{cursor:default}.option.good{background:#e0f1e8;border-color:#8ab59b;color:#245d40}.option.bad{background:#f8e5ed;border-color:#cc9bad;color:#863d55}.feedback{font-size:12px;min-height:34px;color:#6d5b80}.footer{border-top:1px solid #e3daef;padding-top:10px;display:grid;gap:8px}.actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.reveal,.resume{background:transparent;border:0;color:#735298;font-size:12px;font-weight:600;min-height:36px;padding:6px 0}.next{background:#9071c5;border:0;border-radius:12px;color:#fff;font-weight:650;padding:10px 15px;min-height:42px}.next[hidden],.option[hidden],.rating[hidden]{display:none}.small{font-size:10px;color:#887895;letter-spacing:.7px}.summary[hidden],.quiz[hidden]{display:none}.score{font-size:30px;font-weight:750;margin:12px 0}.muted{color:#76628f}
@media(prefers-color-scheme:dark){body{background:#292235;color:#f3edfc}.hint,.top,.feedback,.muted{color:#c4b4d8}.track{background:#4d3e5f}.option{background:#352c43;border-color:#50405f;color:#efe6f8}.letter,.small{color:#bc9fd6}.reveal,.resume{color:#d3b5f3}.footer{border-color:#50405f}.option.good{background:#254537;color:#c2efd5}.option.bad{background:#533141;color:#ffd3e4}}
</style>
<div class="card"><div class="top"><span><span class="dot"></span>WORDFLOW · <span id="mode">${context.mode}</span></span><span id="counter">${String(context.position + 1).padStart(2, "0")} / ${String(context.total).padStart(2, "0")}</span></div><div class="track"><div class="fill" id="progress"></div></div>
<div class="quiz" id="quiz"><h1 id="term">${escapeHtml(content.term)}</h1><p class="hint" id="hint">${escapeHtml(content.partOfSpeech)} · ${content.kind === "self" ? "вспомните перевод" : "выберите перевод"}</p><div class="answers">${options}</div><p class="feedback" id="feedback" role="status" aria-live="polite">${content.kind === "self" ? "Вспомните перевод, затем откройте ответ." : "Выберите перевод или откройте ответ."}</p><div class="footer"><div class="actions"><button class="reveal" id="reveal">Показать ответ</button><button class="next rating" id="remembered" hidden>Помню</button><button class="next rating" id="forgot" hidden>Не помню</button><button class="next" id="next" hidden>Следующее слово →</button><button class="resume" id="resume">Продолжить занятие</button></div><p class="small">A LITTLE PRACTICE, EVERY DAY</p></div></div>
<div class="summary" id="summary" hidden><h1>Готово! 🎉</h1><p class="hint">Занятие завершено</p><div class="score" id="score"></div><p class="hint" id="details"></p><p class="feedback">Слова запланированы для повторения. Новые слова: /learn · Повторение: /review.</p></div></div>
<script>(function(){
var W=window.TelegramWidget,session='${sessionId}',buttons=Array.from(document.querySelectorAll('.option')),
term=document.getElementById('term'),hint=document.getElementById('hint'),feedback=document.getElementById('feedback'),
remembered=document.getElementById('remembered'),forgot=document.getElementById('forgot'),
reveal=document.getElementById('reveal'),next=document.getElementById('next'),resume=document.getElementById('resume'),
quiz=document.getElementById('quiz'),summary=document.getElementById('summary'),score=document.getElementById('score'),
details=document.getElementById('details'),counter=document.getElementById('counter'),progress=document.getElementById('progress'),
mode=document.getElementById('mode'),revision=-1,position=${context.position},total=${context.total},busy=false,locked=false,disabled=false,self=${content.kind === "self"},shown=false;
function controls(){remembered.disabled=forgot.disabled=busy||disabled||!shown||locked;buttons.forEach(function(b){b.disabled=busy||locked||disabled});reveal.disabled=busy||locked||disabled;resume.disabled=busy||disabled;next.disabled=busy||disabled}
function error(e){feedback.textContent=e&&e.code==='RATE_LIMITED'?'Слишком быстро. Попробуйте ещё раз.':'Не удалось проверить. Повторите действие.'}
function displayQuestion(s){if(!s||!s.content||!Array.isArray(s.content.options)||(s.content.kind==='self'?s.content.options.length!==0:s.content.options.length!==4))throw Error('Invalid question');
position=s.position;total=s.total;self=s.content.kind==='self';shown=false;remembered.hidden=forgot.hidden=true;locked=false;quiz.hidden=false;summary.hidden=true;next.hidden=true;reveal.hidden=false;
term.textContent=s.content.term;hint.textContent=s.content.partOfSpeech+(self?' · вспомните перевод':' · выберите перевод');
buttons.forEach(function(b,i){b.hidden=self;b.querySelector('.value').textContent=s.content.options[i]||'';b.classList.remove('good','bad')});
feedback.textContent=self?'Вспомните перевод, затем откройте ответ.':'Выберите перевод или откройте ответ.';counter.textContent=String(position+1).padStart(2,'0')+' / '+String(total).padStart(2,'0');progress.style.width=(100*(position+1)/total)+'%';controls()}
function render(s){if(!s||typeof s.status!=='string')throw Error('Invalid response');
if(typeof s.revision==='number'){if(s.revision<revision)return;revision=s.revision}if(mode&&s.mode)mode.textContent=s.mode;
if(s.status==='error'||s.status==='expired'){feedback.textContent=s.message;disabled=!s.retryable;controls();return}
if(s.status==='question'){displayQuestion(s);return}
if(s.status==='recall'){displayQuestion(s);shown=true;reveal.hidden=true;remembered.hidden=forgot.hidden=false;feedback.textContent=s.answer+(s.example?' · '+s.example:'');controls();return}
if(s.status==='completed'){quiz.hidden=true;summary.hidden=false;counter.textContent=String(s.total).padStart(2,'0')+' / '+String(s.total).padStart(2,'0');progress.style.width='100%';
score.textContent=s.correctCount+' / '+s.total+' правильно';details.textContent='Точность: '+s.accuracy+'% · Ошибок: '+s.incorrectCount;disabled=true;return}
if(s.status!=='answered'&&s.status!=='revealed')throw Error('Invalid feedback');
if(typeof s.position==='number')position=s.position;if(typeof s.total==='number')total=s.total;locked=true;buttons.forEach(function(b,i){b.classList.remove('good','bad');if(i===s.selected)b.classList.add(s.correct?'good':'bad');if(i===s.correctIndex)b.classList.add('good')});
feedback.textContent=s.correct?'Верно! Отличная работа.':('Правильный ответ: '+(s.answer||'смотрите зелёный вариант'));
remembered.hidden=forgot.hidden=true;reveal.hidden=true;next.hidden=false;next.textContent=position===total-1?'Посмотреть результат →':'Следующее слово →';controls()}
function ask(action){if(!W||busy||disabled)return;busy=true;controls();feedback.textContent='Проверяем…';
try{W.request('q:'+session+':'+action).then(function(a){try{render(JSON.parse(a.result))}catch(e){error(e)}},error).finally(function(){busy=false;controls()})}
catch(e){busy=false;error(e);controls()}}
buttons.forEach(function(b){b.addEventListener('click',function(){if(!locked)ask(position+':a'+b.dataset.choice)})});
reveal.addEventListener('click',function(){if(!locked)ask(position+':r')});
remembered.addEventListener('click',function(){if(shown&&!locked)ask(position+':k')});
forgot.addEventListener('click',function(){if(shown&&!locked)ask(position+':f')});
next.addEventListener('click',function(){if(locked)ask(position+':n')});
resume.addEventListener('click',function(){ask('s')});
if(!W||!W.viewer||W.isPreview||W.isForward){disabled=true;feedback.textContent='Откройте /learn в личном чате с WordFlow.'}
progress.style.width=(100*(position+1)/total)+'%';controls();if(W)W.ready();
})();</script>`;
}
