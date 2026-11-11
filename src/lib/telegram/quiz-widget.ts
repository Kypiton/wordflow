import "server-only";

/** Presentation only: the answer key and grading rules live in quiz.ts. */
export function quizWidgetHtml(sessionId: string): string {
  if (!/^[a-f0-9]{24}$/.test(sessionId)) throw new Error("Invalid quiz session.");
  return `<style>
*{box-sizing:border-box}body{margin:0;padding:0;background:#f5f1fc;color:#302642;font:15px/1.4 system-ui,sans-serif}.card{padding:22px 22px max(22px,env(safe-area-inset-bottom));max-width:600px}.top{display:flex;justify-content:space-between;align-items:center;color:#76628f;font-size:11px;letter-spacing:1.4px;font-weight:700}.dot{width:7px;height:7px;border-radius:50%;background:#9a7cc4;display:inline-block;margin-right:6px}h1{font-size:34px;line-height:1.15;letter-spacing:-1px;margin:23px 0 5px}p{margin:0}.hint{color:#7a6d89;font-size:13px}.answers{display:grid;gap:8px;margin:20px 0 14px}button{font:inherit;cursor:pointer;touch-action:auto}.option{display:flex;align-items:center;gap:12px;width:100%;min-height:48px;text-align:left;border:1px solid #e3daef;border-radius:14px;padding:10px 13px;background:#fff;color:#403250}.letter{font-size:11px;color:#8a729f;font-weight:700}.option:active{background:#e8def6}.option[disabled]{cursor:default;opacity:.65}.option.good{background:#e0f1e8;border-color:#8ab59b;color:#245d40;opacity:1}.option.bad{background:#f8e5ed;border-color:#cc9bad;color:#863d55;opacity:1}.feedback{font-size:13px;min-height:37px;color:#6d5b80}.footer{border-top:1px solid #e3daef;padding-top:8px}.reveal{background:transparent;border:0;color:#735298;font-size:13px;font-weight:600;min-height:42px;padding:7px 0}.reveal[disabled]{opacity:.5}.small{font-size:10px;color:#887895;letter-spacing:.7px}
@media(prefers-color-scheme:dark){body{background:#292235;color:#f3edfc}.hint,.top,.feedback{color:#c4b4d8}.option{background:#352c43;border-color:#50405f;color:#efe6f8}.letter,.small{color:#bc9fd6}.reveal{color:#d3b5f3}.footer{border-color:#50405f}.option:active{background:#48365d}.option.good{background:#254537;color:#c2efd5}.option.bad{background:#533141;color:#ffd3e4}}
</style><div class="card"><div class="top"><span><span class="dot"></span>WORDFLOW</span><span>01 / 01</span></div><h1>Reluctant</h1><p class="hint">adjective · выберите перевод</p><div class="answers"><button class="option" data-choice="0"><span class="letter">A</span>Уверенный</button><button class="option" data-choice="1"><span class="letter">B</span>Любопытный</button><button class="option" data-choice="2"><span class="letter">C</span>Неохотный</button><button class="option" data-choice="3"><span class="letter">D</span>Щедрый</button></div><p class="feedback" id="feedback" role="status" aria-live="polite">Одно новое слово — маленький шаг вперёд.</p><div class="footer"><button class="reveal" id="reveal">Показать ответ</button><p class="small">A LITTLE PRACTICE, EVERY DAY</p></div></div><script>
(function(){
var bridge=window.TelegramWidget,buttons=Array.from(document.querySelectorAll('.option')),feedback=document.getElementById('feedback'),reveal=document.getElementById('reveal'),busy=false,locked=false,finished=false;
function controls(){buttons.forEach(function(b){b.disabled=busy||locked});reveal.disabled=busy||finished}
function failed(e){feedback.textContent=e&&e.code==='RATE_LIMITED'?'Слишком быстро. Подождите немного и нажмите снова.':'Не удалось проверить. Нажмите ещё раз.'}
function render(s){
if(!s||typeof s.status!=='string')throw Error();
if(s.status==='error'||s.status==='expired'){feedback.textContent=s.message;locked=true;finished=true;return}
if(s.status!=='answered'&&s.status!=='revealed')throw Error();
locked=true;
buttons.forEach(function(b,i){b.classList.remove('good','bad');if(i===s.selected)b.classList.add(s.correct?'good':'bad');if(i===s.correctIndex)b.classList.add('good')});
feedback.textContent=s.status==='revealed'?'Reluctant — '+s.answer:(s.correct?'Верно! Отличная работа.':'Пока не совсем. Посмотрите правильный ответ.');
if(s.status==='revealed'){finished=true;reveal.textContent='Новое занятие: /learn'}
}
function ask(action){
if(busy||finished)return;
busy=true;controls();feedback.textContent='Проверяем…';
try{bridge.request('q:${sessionId}:'+action).then(function(a){try{render(JSON.parse(a.result))}catch(e){failed(e)}} ,failed).finally(function(){busy=false;controls()})}catch(e){busy=false;failed(e);controls()}
}
buttons.forEach(function(b){b.addEventListener('click',function(){if(!locked)ask('a'+b.dataset.choice)})});
reveal.addEventListener('click',function(){ask('r')});
if(!bridge||!bridge.viewer||bridge.isPreview||bridge.isForward){locked=true;finished=true;feedback.textContent='Откройте /learn в личном чате с WordFlow.';controls()}
if(bridge)bridge.ready();
})();
</script>`;
}
