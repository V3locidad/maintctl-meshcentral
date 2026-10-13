const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const root = path.join(__dirname, '..');
function server(archive) {
  const sent=[], files=new Map();
  if(archive) files.set(path.join(root,'maintctl-multilogin-events.json'),JSON.stringify(archive));
  const fakeFs={
    existsSync:p=>files.has(p),readFileSync(p){if(!files.has(p))throw Error('ENOENT');return files.get(p);},
    writeFileSync:(p,s)=>files.set(p,s),renameSync(a,b){files.set(b,files.get(a));files.delete(a);},unlinkSync:p=>files.delete(p)
  };
  const docs={mesh:[{_id:'mesh/test/a',name:'Salle A'}],sysinfo:[],node:[{_id:'node/test/a',name:'PC-01',meshid:'mesh/test/a',agent:{id:4},osdesc:'Windows 11'}]};
  const mesh={db:{GetAllType(type,cb){cb(null,docs[type]||[]);}},webserver:{wsagents:{'node/test/a':{send(s){sent.push(JSON.parse(s));}}}}};
  const sandbox={module:{exports:{}},__dirname:root,console,Buffer,Set,URL,process:{platform:'linux'},
    require:name=>name==='fs'?fakeFs:require(name),setInterval:()=>({unref(){}}),clearInterval(){},setTimeout:()=>({unref(){}}),clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'maintctl.js'),'utf8'),sandbox);
  const plugin=sandbox.module.exports.maintctl({parent:mesh});
  function request(action,query={}) {
    let code=200,result;
    const res={status(c){code=c;return this;},set(){return this;},send(data){result=JSON.parse(data);}};
    plugin.handleAdminReq({query:{action,...query},headers:{}},res,{name:'tester'});
    assert.ok(result,'request must produce a response');return {code,data:result};
  }
  return {request,plugin,sent,files};
}
test('removed exam and unknown HTTP actions return 404 without dispatch',()=>{
  const h=server();
  for(const action of ['examLock','examUnlock','examStatus','examLocksList','unknown']) {
    const r=h.request(action,{payload:JSON.stringify({nodes:['node/test/a']})});assert.equal(r.code,404);assert.match(r.data.error,/retirée/);
  }
  assert.equal(h.sent.length,0);
});
test('agent rejects removed exam commands without loading a process runner; ping remains available',()=>{
  const messages=[],loads=[];const sandbox={module:{exports:{}},process:{platform:'linux'},console,
    require(name){loads.push(name);if(name==='fs')return{readFileSync(){return '';},writeFileSync(){}};throw Error('unexpected module '+name);}};
  vm.runInNewContext(fs.readFileSync(path.join(root,'modules_meshcore/maintctl.js'),'utf8'),sandbox);
  const run=action=>sandbox.module.exports.consoleaction({pluginaction:action,dispatchId:'test'},0,null,{SendCommand:m=>messages.push(m)});
  for(const action of ['examLock','examUnlock','examStatus']) {run(action);assert.equal(messages.at(-1).pluginaction,'unknownAction');assert.equal(messages.at(-1).ok,false);}
  assert.equal(run('ping'),'pong');assert.equal(messages.at(-1).pluginaction,'pong');assert.ok(loads.every(name=>name==='fs'));
});
test('cleanup still dispatches selected tasks, records offline hosts and accepts completion',()=>{
  const h=server();const r=h.request('run',{payload:JSON.stringify({nodes:['node/test/a','node/test/offline'],tasks:['temp'],profileDays:90})});
  assert.equal(r.code,200);assert.equal(r.data.dispatched,1);assert.equal(r.data.offline,1);
  assert.equal(h.sent[0].pluginaction,'clean');assert.deepEqual(h.sent[0].tasks,['temp']);
  h.plugin.serveraction({pluginaction:'cleanComplete',dispatchId:h.sent[0].dispatchId,ok:true,results:{temp:{ok:true,bytes:2048}}},{dbNodeKey:'node/test/a'});
  const run=h.request('runStatus',{runId:r.data.runId}).data;
  assert.equal(run.results['node/test/a'].status,'done');assert.equal(run.results['node/test/a'].totalBytes,2048);assert.equal(run.results['node/test/offline'].status,'offline');
  assert.equal(h.request('nodeHistory',{nodeId:'node/test/a',kind:'clean'}).data.runs.length,1);
});
test('invalid cleanup selections never dispatch work',()=>{
  const h=server();
  for(const payload of [{nodes:[],tasks:['temp']},{nodes:['node/test/a'],tasks:['examLock']}]) assert.equal(h.request('run',{payload:JSON.stringify(payload)}).code,400);
  assert.equal(h.sent.length,0);
});
test('agent inventory and health remain available',()=>{
  const h=server();assert.equal(h.request('agents').data.agents[0].name,'PC-01');const health=h.request('health').data;
  assert.equal(health.agents[0].online,true);assert.equal(health.thresholds.diskWarnGB,10);assert.equal(health.alertCount,0);
});
test('multi-login keeps settings and only retains conflicts and decisions from the last 30 days',()=>{
  const now=Date.now(),old=now-32*86400000;
  const h=server({events:[{time:now,detail:'recent'},{time:old,detail:'expired'}],conflicts:[{firstSeenAt:now,lastSeenAt:now,endedAt:now,username:'recent',sessions:[]},{firstSeenAt:old,lastSeenAt:old,endedAt:old,username:'expired',sessions:[]}]});
  const r=h.request('multiLoginStatus').data;
  assert.equal(r.settings.enabled,false);assert.equal(r.conflictRetentionDays,30);assert.equal(r.conflictHistory.length,1);assert.equal(r.conflictHistory[0].username,'recent');assert.equal(r.events.length,1);
  assert.equal(h.sent.length,0);
});
