const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const html = fs.readFileSync(path.join(__dirname, '../views/maintctl.handlebars'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const flush = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; }
function ui() {
  const elements = {}, timers = [], requests = [];
  function el(id) {
    if (elements[id]) return elements[id];
    const classes = new Set(), handlers = {};
    return elements[id] = {
      id, value: '', checked: false, disabled: false, hidden: false, style: {}, textContent: '', scrollTop: 0, scrollLeft: 0, writes: 0,
      get innerHTML() { return this.html || ''; },
      set innerHTML(value) { this.html = value; this.writes++; this.scrollTop = this.scrollLeft = 0; },
      classList: { add: x=>classes.add(x), remove: x=>classes.delete(x), contains: x=>classes.has(x), toggle: (x,on)=>on?classes.add(x):classes.delete(x) },
      addEventListener(type,fn) { (handlers[type] ||= []).push(fn); },
      emit(type,event={}) { return Promise.all((handlers[type] || []).map(fn=>fn(event))); },
      setAttribute(name,value) { this[name] = value; }, getAttribute(name) { return this[name]; },
      querySelectorAll() { return []; }, focus() {}, click() { return this.emit('click'); }
    };
  }
  const tabs = ['health','clean','devices','drivers','events','registry','sessions'].map(name=>{ const e=el('tab-'+name);e['data-tab']=name;return e; });
  const tasks = ['temp','browser','dism','profiles'].map(name=>{ const e=el('task-'+name);e.value=name;return e; });
  const radios = ['block','prompt'].map(name=>{ const e=el('mode-'+name);e.value=name;return e; });
  radios[0].checked = true;
  const document = {
    getElementById: el, body: el('body'), addEventListener() {},
    querySelectorAll(q) { return q==='.tab'?tabs:q==='.panel'?tabs.map(t=>el('panel-'+t['data-tab'])):q==='.taskCheck'?tasks:q==='input[name="multiLoginMode"]'?radios:[]; },
    querySelector(q) {
      const tab = q.match(/data-tab="([^"]+)"/); if(tab) return el('tab-'+tab[1]);
      const radio = q.match(/value="([^"]+)"/); if(radio) return el('mode-'+radio[1]);
      if(q.includes('multiLoginMode')) return radios.find(r=>r.checked); return null;
    }
  };
  const sandbox = {
    document, window: { scrollX: 0, scrollY: 0, scrollTo(x,y){this.scrollX=x;this.scrollY=y;}, confirm:()=>false },
    console, URL, Promise, Set, Date, alert: msg=>assert.fail(msg),
    localStorage: {getItem:()=>null,setItem(){},removeItem(){}},
    setTimeout:()=>1, clearTimeout(){}, setInterval(fn,ms){ timers.push({fn,ms});return timers.length;},clearInterval(){},
    XMLHttpRequest: function(){ this.open=()=>{};this.send=()=>{}; },
    fetch: ()=>Promise.reject(new Error('unexpected fetch'))
  };
  vm.createContext(sandbox); vm.runInContext(script,sandbox);
  sandbox.healthLoading = null; // Initial XHR requests intentionally stay isolated from test API responses.
  sandbox.getJson = url => { const d=deferred();requests.push({url,...d});return d.promise; };
  return { sandbox, el, tasks, timers, requests };
}
const nodes = [
  {id:'a',name:'PC-01',mesh:'Salle A',family:'Windows',os:'Windows 11',model:'ThinkCentre',online:true},
  {id:'b',name:'PC-02',mesh:'Salle B',family:'Windows',os:'Windows 10',model:'OptiPlex',online:false},
  {id:'c',name:'LINUX',mesh:'Salle A',family:'Linux',os:'Ubuntu',model:'ThinkCentre',online:true}
];
function health() { return { agents: nodes.slice(0,2).map((n,i)=>({...n,health:{diskFreeGB: i?100:1,diskTotalGB:256,diskFreePct:i?39:0.4,uptimeDays:3},alerts:i?[]:[{level:'critical',message:'Disque presque plein'}]})),criticalCount:1,warningCount:0,alertCount:1,thresholds:{diskWarnGB:10,diskCriticalGB:2,uptimeWarnDays:21,uptimeCriticalDays:45} }; }
function status() { return { settings:{enabled:true,mode:'block',promptTimeoutSeconds:45,excludedUsers:['admin']},watcher:{running:2,online:2},sessions:[{username:'alice',name:'PC-01',mesh:'Salle A',updatedAt:123},{username:'bob',name:'PC-02',mesh:'Salle B',updatedAt:123}],conflicts:[{username:'alice',sessions:[{name:'PC-01',mesh:'Salle A'},{name:'PC-03',mesh:'Salle C'}]}],conflictHistory:[],events:[{time:123,username:'alice',detail:'Connexion refusée'}] }; }
async function sessions(h) { await h.el('tab-sessions').click();h.requests.at(-1).resolve(status());await flush(); }

test('all seven tabs are keyboard navigable and exam UI is absent', async()=>{
  const h=ui();
  assert.doesNotMatch(html,/examLock|panel-exam|tab-exam/i);
  await h.el('tab-health').emit('keydown',{key:'End',preventDefault(){}});
  assert.equal(h.el('tab-sessions')['aria-selected'],'true');
  assert.equal(h.el('tab-health').tabIndex,-1);
  assert.equal(h.el('panel-sessions').classList.contains('active'),true);
});
test('select displayed cleanup hosts matches OS/model search, Windows and online filters', async()=>{
  const h=ui();h.sandbox.agents=nodes;h.el('searchAgents').value='WINDOWS 10';
  await h.el('selectAllBtn').click();assert.deepEqual(Object.keys(h.sandbox.selected),['b']);
  await h.el('selectNoneBtn').click();h.el('searchAgents').value='ThinkCentre';h.el('onlineOnly').checked=true;
  await h.el('selectAllBtn').click();assert.deepEqual(Object.keys(h.sandbox.selected),['a']);
});
test('driver selection uses the same displayed host filter and preserves previous selection',async()=>{
  const h=ui();h.sandbox.agents=nodes;h.sandbox.drvSelected={a:true};h.el('drvSearchAgents').value='windows 10';
  await h.el('drvSelectAllBtn').click();assert.deepEqual(Object.keys(h.sandbox.drvSelected),['a','b']);
});
test('cleanup requires both hosts and tasks and preserves the existing confirmation gate', async()=>{
  const h=ui();h.sandbox.selected={a:true};h.sandbox.updateSelCount();assert.equal(h.el('runBtn').disabled,true);
  h.tasks[0].checked=true;await h.tasks[0].emit('change');assert.equal(h.el('runBtn').disabled,false);
  h.sandbox.runClean();assert.equal(h.requests.length,0);
  h.sandbox.selected={};h.sandbox.updateSelCount();assert.equal(h.el('runBtn').disabled,true);
});
test('health filters affect both cards and alerts without changing the fetched timestamp',()=>{
  const h=ui();h.sandbox.healthData=health();h.sandbox.healthFetchedAt=123000;h.sandbox.renderHealth();
  const stamp=h.el('healthLastUpdate').textContent;
  h.el('healthRoom').value='Salle B';h.sandbox.renderHealth();
  assert.match(h.el('healthGroups').innerHTML,/PC-02/);assert.doesNotMatch(h.el('healthGroups').innerHTML,/PC-01/);
  assert.match(h.el('healthAlertsList').innerHTML,/Aucune alerte/);assert.equal(h.el('healthLastUpdate').textContent,stamp);
  h.el('healthRoom').value='';h.el('healthSearch').value='ThinkCentre';h.sandbox.renderHealth();
  assert.match(h.el('healthGroups').innerHTML,/PC-01/);assert.doesNotMatch(h.el('healthGroups').innerHTML,/PC-02/);
});
test('health refresh deduplicates requests and preserves DOM and scroll for unchanged responses', async()=>{
  const h=ui();const first=h.sandbox.refreshHealth();assert.equal(h.sandbox.refreshHealth(),first);assert.equal(h.requests.length,1);
  h.requests[0].resolve(health());await first;const group=h.el('healthGroups');const writes=group.writes;group.scrollTop=140;
  const second=h.sandbox.refreshHealth();h.requests[1].resolve(health());await second;
  assert.equal(group.writes,writes);assert.equal(group.scrollTop,140);assert.equal(h.el('healthRefreshBtn').disabled,false);
});
test('health refresh failures preserve last data and release refresh control',async()=>{
  const h=ui();h.sandbox.healthData=health();h.sandbox.renderHealth();const before=h.el('healthGroups').innerHTML;
  const pending=h.sandbox.refreshHealth();h.requests[0].reject(new Error('network'));await pending;
  assert.equal(h.el('healthGroups').innerHTML,before);assert.match(h.el('healthLastUpdate').textContent,/dernières données conservées/);assert.equal(h.el('healthRefreshBtn').disabled,false);
});
test('session polling does not rewrite unchanged content or reset scroll',async()=>{
  const h=ui();await sessions(h);const panel=h.el('panel-sessions'),events=h.el('multiLoginEvents');panel.scrollTop=220;events.scrollTop=95;const writes=events.writes;
  const timer=h.timers.find(t=>t.ms===10000);timer.fn();timer.fn();assert.equal(h.requests.length,2);
  h.requests[1].resolve(status());await flush();assert.equal(events.writes,writes);assert.equal(events.scrollTop,95);assert.equal(panel.scrollTop,220);
});
test('typing before blur survives manual refresh and reset restores saved settings',async()=>{
  const h=ui();await sessions(h);h.el('multiLoginExcluded').value='admin, nouvel-exclu';await h.el('multiLoginExcluded').emit('input');
  await h.el('multiLoginRefreshBtn').click();h.requests.at(-1).resolve(status());await flush();
  assert.equal(h.el('multiLoginExcluded').value,'admin, nouvel-exclu');assert.match(h.el('multiLoginEditState').textContent,/non enregistrées/);
  await h.el('multiLoginResetBtn').click();assert.equal(h.el('multiLoginExcluded').value,'admin');assert.equal(h.el('multiLoginResetBtn').hidden,true);
});
test('stale pre-save status cannot overwrite successful settings',async()=>{
  const h=ui();await sessions(h);await h.el('multiLoginRefreshBtn').click();const stale=h.requests.at(-1);
  h.el('multiLoginExcluded').value='saved';await h.el('multiLoginExcluded').emit('input');const saving=h.el('multiLoginSaveBtn').click();
  const save=h.requests.at(-1);assert.match(save.url,/action=multiLoginSave/);save.resolve({ok:true});await flush();
  const fresh=h.requests.at(-1);const data=status();data.settings.excludedUsers=['saved'];fresh.resolve(data);await saving;
  stale.resolve(status());await flush();assert.equal(h.el('multiLoginExcluded').value,'saved');assert.equal(h.el('multiLoginResetBtn').hidden,true);
});
test('new edits typed while saving are not discarded by save completion',async()=>{
  const h=ui();await sessions(h);h.el('multiLoginExcluded').value='first';await h.el('multiLoginExcluded').emit('input');const saving=h.el('multiLoginSaveBtn').click();
  const request=h.requests.at(-1);h.el('multiLoginExcluded').value='first, second';await h.el('multiLoginExcluded').emit('input');
  request.resolve({ok:true});await flush();const data=status();data.settings.excludedUsers=['first'];h.requests.at(-1).resolve(data);await saving;
  assert.equal(h.el('multiLoginExcluded').value,'first, second');assert.equal(h.el('multiLoginResetBtn').hidden,false);
});
test('connection search filters sessions, conflicts and decisions without losing settings edits',async()=>{
  const h=ui();await sessions(h);h.el('multiLoginSearch').value='bob';await h.el('multiLoginSearch').emit('input');
  assert.match(h.el('multiLoginSessions').innerHTML,/bob/);assert.doesNotMatch(h.el('multiLoginSessions').innerHTML,/alice/);
  assert.doesNotMatch(h.el('multiLoginConflicts').innerHTML,/alice/);assert.doesNotMatch(h.el('multiLoginEvents').innerHTML,/alice/);
});
