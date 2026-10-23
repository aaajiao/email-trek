'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const vm = require('vm')
const { createRequire } = require('module')
const { EventEmitter } = require('events')
const root = process.env.EMAILTREK_CANDIDATE_ROOT || (fs.existsSync(path.resolve(__dirname, '../candidate/lib')) ? path.resolve(__dirname, '../candidate') : path.resolve(__dirname, '..'))
const safety = require(path.join(root, 'lib/publicSafety'))
const createQuota = require(path.join(root, 'lib/mailQuota'))
const Queue = require(path.join(root, 'lib/singleQueue'))
const { create: createVerifier } = require(path.join(root, 'lib/mailVerifier'))
const tests = []
const test = (name, fn) => tests.push({ name, fn })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const waitFor = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await sleep(5) } throw new Error('Timed out waiting for fixture') }
function quotaFixture(extra = {}) {
  let clock = 1700000000000
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'email-quota-'))
  const options = { directory, now: () => clock, ...extra }
  return { directory, options, quota: createQuota(options), advance: ms => { clock += ms } }
}
function reserve(q, n = 0, ip = '203.0.113.' + (n + 1), mail = 'reader' + n + '@example.test') {
  const ticket = q.reserve(ip, mail)
  if (ticket.allowed) ticket.release()
  return ticket
}
function load(relative, mocks) {
  const filename = path.join(root, relative)
  const realRequire = createRequire(filename)
  const module = { exports: {} }
  const context = { module, exports: module.exports, require: name => Object.prototype.hasOwnProperty.call(mocks, name) ? mocks[name] : realRequire(name),
    __filename: filename, __dirname: path.dirname(filename), Buffer, URL, process, console,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  return module.exports
}

test('single-mailbox type, size, address-list and control-character validation', () => {
  for (const bad of [null, {}, ['a@example.test'], 42, '', 'a@example.test,b@example.test', 'Name <a@example.test>', 'a\r\nBcc:b@example.test', 'a..b@example.test', 'a@example.test;', 'a'.repeat(65)+'@example.test', 'a@-bad.example', 'a@localhost']) assert.strictEqual(safety.mailAddress(bad), null)
  assert.strictEqual(safety.mailAddress(' Reader+work@EXAMPLE.TEST '), 'Reader+work@example.test')
  assert.strictEqual(safety.pageNumber('2000', 1, 2000), 2000)
  for (const bad of ['2000junk', -1, 2001, 1.5, [], {}, '1e3']) assert.strictEqual(safety.pageNumber(bad, 1, 2000), null)
})
test('only exact configured proxy peers can supply X-Real-IP; XFF ignored', () => {
  process.env.EMAILTREK_TRUSTED_PROXY_IPS = '172.22.0.1'
  const req = { socket: { remoteAddress: '::ffff:172.22.0.1' }, headers: {'x-real-ip':'203.0.113.8', 'x-forwarded-for':'9.9.9.9'} }
  assert.strictEqual(safety.clientIP(req), '203.0.113.8')
  req.socket.remoteAddress = '203.0.113.9'
  assert.strictEqual(safety.clientIP(req), '203.0.113.9')
  req.socket.remoteAddress = '172.22.0.1';req.headers['x-real-ip']='1.2.3.4, 8.8.8.8'
  assert.strictEqual(safety.clientIP(req), null)
  req.socket.remoteAddress='2001:0db8:0000:0000:0000:0000:0000:0001'
  assert.strictEqual(safety.clientIP(req), '2001:db8::1')
})
test('IP burst and daily quotas, recipient cooldown and daily quotas', () => {
  let f = quotaFixture()
  for(let i=0;i<3;i++) assert(reserve(f.quota,i,'203.0.113.9').allowed)
  assert(!reserve(f.quota,4,'203.0.113.9').allowed)
  f.advance(15*60000+1); assert(reserve(f.quota,5,'203.0.113.9').allowed)
  f=quotaFixture()
  for(let i=0;i<20;i++){ assert(reserve(f.quota,i,'203.0.113.9').allowed);f.advance(16*60000) }
  assert(!reserve(f.quota,21,'203.0.113.9').allowed)
  f=quotaFixture()
  assert(reserve(f.quota,0,'203.0.113.1','Reader@example.test').allowed)
  assert(!reserve(f.quota,1,'203.0.113.2','reader@example.test').allowed)
  for(let i=1;i<5;i++){f.advance(10*60000+1);assert(reserve(f.quota,i,'203.0.113.'+(i+1),'reader@example.test').allowed)}
  f.advance(10*60000+1);assert(!reserve(f.quota,7,'203.0.113.8','reader@example.test').allowed)
})
test('global hourly/daily limits and concurrent reservations', () => {
  let f=quotaFixture()
  for(let i=0;i<30;i++) assert(reserve(f.quota,i).allowed)
  assert(!reserve(f.quota,30).allowed)
  f=quotaFixture()
  for(let i=0;i<100;i++){assert(reserve(f.quota,i).allowed);f.advance(4*60000)}
  assert(!reserve(f.quota,100).allowed)
  f=quotaFixture()
  const a=f.quota.reserve('203.0.113.1','a@example.test'), b=f.quota.reserve('203.0.113.2','b@example.test')
  assert(a.allowed&&b.allowed);assert(!reserve(f.quota,3).allowed)
  a.release();a.release();assert(reserve(f.quota,3).allowed);b.release()
})
test('quotas persist across restart, keys contain no email/IP, files 0600, expiry bounded', () => {
  const f=quotaFixture()
  assert(reserve(f.quota,1,'203.0.113.123','private-reader@example.test').allowed)
  const q2=createQuota(f.options)
  assert(!reserve(q2,2,'203.0.113.124','PRIVATE-READER@example.test').allowed)
  const file=path.join(f.directory,'mail-quota.json'), body=fs.readFileSync(file,'utf8')
  assert(!body.includes('private-reader')&&!body.includes('203.0.113'))
  for(const name of ['mail-quota.json','quota-hmac.key'])assert.strictEqual(fs.statSync(path.join(f.directory,name)).mode&511,384)
  f.advance(25*3600000);assert(reserve(q2,3).allowed)
  const data=JSON.parse(fs.readFileSync(file));assert.strictEqual(data.global.length,1);assert.strictEqual(Object.keys(data.keys).length,2)
})
test('corrupt/missing-secret state fails closed; no reset to empty allowance', () => {
  const f=quotaFixture();reserve(f.quota,0)
  fs.writeFileSync(path.join(f.directory,'mail-quota.json'),'broken')
  assert.throws(()=>createQuota(f.options).reserve('203.0.113.8','z@example.test'),/temporarily unavailable/)
  fs.unlinkSync(path.join(f.directory,'quota-hmac.key'))
  assert.throws(()=>createQuota(f.options).reserve('203.0.113.8','z@example.test'),/temporarily unavailable/)
})
test('SVG export includes complete address and only allowed fields; live socket stays masked', () => {
  const rec={_id:'id',created_at:'date',to:'private-reader@example.test',status:'verified',secret:'not public'}
  const p=safety.exportRecord(rec)
  assert.deepStrictEqual(Object.keys(p),['_id','created_at','to','status'])
  assert.strictEqual(p.to,rec.to);assert(!JSON.stringify(p).includes('not public'))
  assert.strictEqual(safety.publicResult({success:true,mailAddr:rec.to,status:'sent'}).mailAddr,'█'.repeat(rec.to.length))
})
test('queue catches reject/throw, recovers once, and does not overlap after reconnect', async () => {
  let calls=0,active=0,max=0,complete
  const q=new Queue(cb=>{calls++;active++;max=Math.max(active,max); if(calls===1){active--;return Promise.reject(new Error('fixture failure'))} complete=()=>{active--;cb(null,{ok:true})}},error=>{if(!error)q.stop()},1)
  q.start();await waitFor(()=>calls===2);q.stop();q.start();await sleep(10);assert.strictEqual(calls,2)
  complete();await waitFor(()=>calls===3);assert.strictEqual(max,1);q.stop();complete();await sleep(10);assert.strictEqual(q.running,0)
})
test('verifier total timeout kills pending work and fresh worker recovers', async () => {
  class FakeWorker extends EventEmitter {
    constructor(){super();FakeWorker.instances.push(this)}
    unref(){}
    postMessage(m){this.message=m;if(FakeWorker.respond)setImmediate(()=>this.emit('message',{id:m.id,info:{success:true,code:1}}))}
    terminate(){this.terminated=true;return Promise.resolve()}
  }
  FakeWorker.instances=[];FakeWorker.respond=false
  const v=createVerifier({Worker:FakeWorker,timeout:20})
  await assert.rejects(v.verify('a@example.test',{timeout:15}),e=>e.code==='VERIFY_TIMEOUT')
  assert(FakeWorker.instances[0].terminated)
  FakeWorker.respond=true;assert.strictEqual((await v.verify('b@example.test',{})).success,true)
  v.close()
})
test('actual runtime Worker runs local verifier with existing validator and no DNS or SMTP', async () => {
  const verifier=createVerifier({timeout:2000})
  try { await assert.rejects(verifier.verify('invalid structure',{}),e=>e.code==='VERIFY_TEMPORARY_FAILURE') }
  finally { verifier.close() }
})
test('MailYou sent/verified/rejected each count once; unknown verification never writes or sends', async () => {
  let verified={success:true}, inserted=[], sent=[], smtpFailure=false
  const Mail=load('lib/mail.js',{
    '../config':{SMTP_CONF:{},VERIFIER:{timeout:15000},MAILOPTIONS:{subject:'fixture'},MAIL_STATUS:{VERIFIED:'verified',NOT_EXISTS:'not_exists',SENT:'sent'}},
    nodemailer:{createTransport:()=>({sendMail:async data=>{sent.push(data);if(smtpFailure)throw new Error('fixture SMTP failure')}})},
    // Pacing has a separate real-budget suite; this case isolates final record semantics.
    './smtpBudget':()=>({reserve:()=>({allowed:true,id:'fixture'}),finish:()=>true}),
    './mail-content':'fixture-only', './mail-address-generator':{gen:()=> 'fixture@example.test'},
    'email-verify':{}, './mailVerifier':{verify:async()=>{if(verified instanceof Error)throw verified;return verified}},
  })
  const mail=new Mail({insertOne:async row=>{inserted.push(row)}})
  const result=await mail.sendMail('reader@example.test')
  assert.strictEqual(result.success,true);assert.strictEqual(sent.length,1);assert.strictEqual(inserted.length,1);assert.strictEqual(inserted[0].status,'sent')
  for(const value of [new Error('timeout'),undefined,null,{}]){
    verified=value;await assert.rejects(mail.sendMail('reader@example.test'))
    assert.strictEqual(sent.length,1);assert.strictEqual(inserted.length,1)
  }
  verified={success:false};assert.strictEqual((await mail.sendMail('missing@example.test')).success,false)
  assert.strictEqual(sent.length,1);assert.strictEqual(inserted.length,2);assert.strictEqual(inserted[1].status,'not_exists')
  verified={success:true};smtpFailure=true;assert.strictEqual((await mail.sendMail('reader@example.test')).success,false)
  assert.strictEqual(sent.length,2);assert.strictEqual(inserted.length,3);assert.strictEqual(inserted[2].status,'verified')
  await mail.checkMail();assert.strictEqual(inserted.length,4);assert.strictEqual(inserted[3].status,'verified');assert.strictEqual(sent.length,2)
})
test('real Express/body-parser endpoints preserve success and reject malformed/limited inputs', async () => {
  const express=require('express'),bodyParser=require('body-parser')
  const app=express();app.use(bodyParser.json({limit:'8kb'}));app.use(bodyParser.urlencoded({extended:false,limit:'8kb',parameterLimit:16}))
  const f=quotaFixture();let sends=0,queries=0,throwSend=false
  require(path.join(root,'lib/setExpressRouter'))(app,{getLimit:async(l,s)=>{queries++;return [{_id:'fixture',to:'private@example.test',status:'verified'}]}},{sendMail:async()=>{sends++;if(throwSend)throw new Error('private SMTP detail');return{success:true}}},{quota:f.quota})
  const server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r))
  function request(route,body){return new Promise((resolve,reject)=>{const payload=JSON.stringify(body);const req=http.request({host:'127.0.0.1',port:server.address().port,path:route,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}},res=>{let data='';res.on('data',x=>data+=x);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(data)}))});req.on('error',reject);req.end(payload)})}
  try{
    assert.strictEqual((await request('/mail-you-send',{data:'reader@example.test'})).body.success,true)
    assert.strictEqual(sends,1)
    for(const data of [null,{},['x@example.test'],'x@example.test,y@example.test','x\n@example.test'])assert.strictEqual((await request('/mail-you-send',{data})).status,400)
    const denied=await request('/mail-you-send',{data:'reader@example.test'});assert.strictEqual(denied.status,429);assert(denied.headers['retry-after']);assert.strictEqual(sends,1)
    throwSend=true;const failed=await request('/mail-you-send',{data:'next@example.test'});assert.strictEqual(failed.status,503);assert(!JSON.stringify(failed).includes('private SMTP'))
    const list=await request('/get-data',{limit:2000,skip:98000});assert(list.body.success);assert(JSON.stringify(list).includes('private@example.test'))
    for(const body of [{limit:2001,skip:0},{limit:1,skip:100000},{limit:'1oops',skip:0},{limit:1,skip:-1}])assert.strictEqual((await request('/get-data',body)).status,400)
    assert.strictEqual(queries,1)
  }finally{await new Promise(r=>server.close(r))}
})
test('frontend accepts append before init, keeps counts loading, and handles stats', () => {
  const handlers={},text={};const socket={on:(e,f)=>handlers[e]=f,emit:()=>{}}
  const context={io:()=>socket,$:selector=>({text:v=>text[selector]=v}),console}
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(root,'public/js/main.js'),'utf8'),context)
  assert(handlers.append);assert.strictEqual(text['#total'],'…')
  handlers.append({mailAddr:'▓'.repeat(12),status:'verified'})
  assert(text['#data>pre'].includes('▓'))
  handlers.init({total:null,maskAscii:['░'.repeat(20)]})
  handlers.stats({total:{not_exists:100,verified:20,sent:3}})
  assert.strictEqual(text['#total'],123)
  handlers.append({mailAddr:'▓'.repeat(254),status:'verified'})
  assert.strictEqual(text['#total'],123) // Server stats are authoritative; no double count.
})
test('worker callback error/no info/throw/reject/temporary failure is isolated and settles once', async () => {
  let handler,mode='good';const responses=[]
  load('lib/verifyWorker.js',{'worker_threads':{parentPort:{on:(e,f)=>handler=f,postMessage:r=>responses.push(r)}},
    './legacySmtpVerifier':{verify:(addr,settings,cb)=>{if(mode==='throw')throw new Error('fixture');if(mode==='reject')return Promise.reject(new Error('fixture'));if(mode==='error')return cb(new Error('fixture'));if(mode==='empty')return cb(null,undefined);if(mode==='timeout')return cb(null,{success:false,code:4});if(mode==='early')return cb(null,{success:false,code:1,rcptReplyCode:null});if(mode==='temporary')return cb(null,{success:false,code:1,rcptReplyCode:450});if(mode==='rejected')return cb(null,{success:false,code:1,rcptReplyCode:550});cb(null,{success:true,code:1,rcptReplyCode:250});cb(null,{success:false,code:2})}}})
  for(const value of ['error','empty','throw','reject','timeout','early','temporary','rejected','good']){mode=value;const before=responses.length;handler({id:before+1,address:'fixture@example.test',settings:{}});await sleep(1);assert.strictEqual(responses.length,before+1);assert.strictEqual(!!responses[before].error,!['good','rejected'].includes(value))}
})
test('socket init shares history, does not await statistics, and handles disconnect before history', async () => {
  let historyResolve,historyCalls=0,verificationCalls=0,statsResolve
  const connection={},broadcast=[]
  const io={on:(e,fn)=>connection[e]=fn,emit:(e,data)=>broadcast.push({e,data})}
  const statsPromise=new Promise(r=>statsResolve=r)
  const controller=require(path.join(root,'lib/setIOEvents'))(io,{genAscii:()=>{historyCalls++;return new Promise(r=>historyResolve=r)},getTotal:()=>statsPromise},{checkMail:()=>{verificationCalls++;return new Promise(()=>{})}})
  function client(id){const listeners={},out=[];const c={id,connected:true,request:{socket:{remoteAddress:'203.0.113.9'},headers:{}},on:(e,f)=>listeners[e]=f,emit:(e,d)=>out.push({e,d}),disconnect:()=>{c.connected=false;if(listeners.disconnect)listeners.disconnect()}};return{c,out,listeners}}
  const a=client('a'),b=client('b');connection.connection(a.c);connection.connection(b.c);await sleep(5)
  assert.strictEqual(historyCalls,1);assert.strictEqual(verificationCalls,1);assert(a.listeners.disconnect)
  a.c.disconnect();historyResolve(['▓▓▓']);await sleep(5);assert.strictEqual(a.out.length,0);assert(b.out.some(x=>x.e==='init'))
  statsResolve({not_exists:5,verified:2,sent:0});await sleep(5);assert(b.out.some(x=>x.e==='stats'));b.c.disconnect();assert(controller.queue._stop);controller.close()
})
test('largest permitted BSON detail stays below 400 bytes and fits 100k within 128MiB', () => {
  const { BSON }=require('mongodb'),bounded=require(path.join(root,'lib/boundedStore'))
  const row=bounded.record({to:'x'.repeat(254),status:'not_exists',created_at:new Date()})
  const bytes=BSON.serialize(row).length;assert(bytes<400);assert(bytes*100000<bounded.SIZE)
})
test('bounded store replays every commit/detail/clear crash boundary exactly once', async () => {
  const fake=require('./fake-mongo'),bounded=require(path.join(root,'lib/boundedStore'))
  for(const [point,after]of [['mail_totals_v1.commit',false],['mail_totals_v1.commit',true],['mail_recent_v1.update',false],['mail_recent_v1.update',true],['mail_totals_v1.update',false],['mail_totals_v1.update',true]]){
    const db=fake.create({mail_recent_v1:[],mail_totals_v1:[{_id:'totals',version:1,mode:'active',counts:bounded.empty()}]});db.options.set(bounded.NAMES.recent,{capped:true,max:bounded.MAX,size:bounded.SIZE})
    let app=await bounded.create(db);db.failAt(point,after)
    await assert.rejects(app.insertOne({created_at:new Date(),to:'fixture@example.test',status:'verified'}))
    app=await bounded.create(db);const expected=point==='mail_totals_v1.commit'&&!after?0:1
    assert.strictEqual((await app.getTotal()).verified,expected);assert.strictEqual((await app.getLimit()).length,expected);assert(!db.rows.get(bounded.NAMES.stats)[0].pending)
  }
})
test('bounded store serializes writers, preserves cumulative counts after recent eviction', async () => {
  const fake=require('./fake-mongo'),bounded=require(path.join(root,'lib/boundedStore'))
  const db=fake.create({mail_recent_v1:[],mail_totals_v1:[{_id:'totals',version:1,mode:'active',counts:bounded.empty()}],mail:[{untouched:true}]});db.options.set(bounded.NAMES.recent,{capped:true,max:bounded.MAX,size:bounded.SIZE});db.capOverride=2
  const app=await bounded.create(db)
  await Promise.all(Array.from({length:10},()=>app.insertOne({created_at:new Date(),to:'fixture@example.test',status:'verified'})))
  assert.strictEqual((await app.getTotal()).verified,10);assert.strictEqual((await app.getLimit()).length,2);assert.strictEqual(db.rows.get('mail').length,1)
  assert.throws(()=>app.insertOne({created_at:new Date(),to:'x'.repeat(255),status:'verified'}));assert.strictEqual((await app.getTotal()).verified,10)
})
test('migration uses exact cutoff plus tail, hashes latest records, activates only after checks, never touches old rows', async () => {
  const fake=require('./fake-mongo'),bounded=require(path.join(root,'lib/boundedStore'))
  const migration=load('lib/migrate-storage.js',{'../config':{MONGO_ADDR:'unused',MONGO_DB:'fixture'}})
  const old=Array.from({length:12},(_,i)=>({_id:new fake.ObjectId(i.toString(16).padStart(24,'0')),created_at:new Date(1700000000000+i),to:'fixture'+i+'@example.test',status:i%2?'verified':'not_exists'}))
  const db=fake.create({mail:old});const before=JSON.stringify(db.rows.get('mail'));const cutoff=new fake.ObjectId('000000000000000000000008')
  const summary={version:1,sourceCollection:'mail',cutoff:String(cutoff),recordCount:8,counts:{not_exists:4,verified:4,sent:0},unknownStatusCount:0,invalidIdCount:0,invalidToCount:0,invalidDateCount:0,groups:['not_exists','verified'].map(status=>({month:'2023-11',status,count:4,invalidId:0,invalidTo:0,invalidDate:0,firstId:'000000000000000000000000',lastId:'000000000000000000000007'}))};
  const base=await migration.prepare(db,cutoff,summary);assert.strictEqual(base.total,8)
  await assert.rejects(migration.finalize(db,cutoff,false),/Stop the legacy/)
  const result=await migration.finalize(db,cutoff,true);assert.strictEqual(result.total,12);assert.strictEqual(result.window.count,12);assert.strictEqual(result.tailCounts.verified,2);assert.strictEqual(JSON.stringify(db.rows.get('mail')),before)
  const proof=await migration.verify(db);assert.strictEqual(proof.window.sha256,result.window.sha256);assert.strictEqual(proof.pending,false)
  const app=await bounded.create(db);await app.insertOne({created_at:new Date(),to:'new@example.test',status:'verified'});assert.strictEqual((await app.getTotal()).verified,7);assert.strictEqual(JSON.stringify(db.rows.get('mail')),before)
})

test('lost quota state with existing key fails closed instead of resetting budgets', () => {
  const f=quotaFixture();reserve(f.quota,0);fs.unlinkSync(path.join(f.directory,'mail-quota.json'))
  assert.throws(()=>createQuota(f.options).reserve('203.0.113.8','fixture@example.test'),/temporarily unavailable/)
})
test('SMTP parser requires complete multiline codes; refuses 250 in 550 body and distinguishes early/temporary failures', async () => {
  async function scenario(mode){let socket,handler;const commands=[];const noop=()=>{}
    const mocks={module:{createRequire:()=>()=>({isEmail:()=>true})},dns:{resolveMx:(d,cb)=>cb(null,[{priority:1,exchange:'fixture.invalid'}])},net:{createConnection:()=>{
      socket=new EventEmitter();socket.setTimeout=noop;socket.destroy=()=>setImmediate(()=>socket.emit('close'));socket.end=()=>setImmediate(()=>socket.emit('end'));
      socket.write=text=>{commands.push(text.split(' ')[0].trim());setImmediate(()=>{
        if(text.startsWith('EHLO')){if(mode==='early')socket.emit('data',Buffer.from('550 refused\r\n'));else{socket.emit('data',Buffer.from('250-first line\r\n'));setImmediate(()=>socket.emit('data',Buffer.from('250 final line\r\n')))}}
        else if(text.startsWith('MAIL'))socket.emit('data',Buffer.from(mode==='mail-denied'?'550 sender refused\r\n':'250 sender OK\r\n'))
        else if(text.startsWith('RCPT'))socket.emit('data',Buffer.from(mode==='accepted'?'250 recipient OK\r\n':mode==='temporary'?'450 try later\r\n':'550 user250@example.test does not exist\r\n'))
        else if(text.startsWith('QUIT'))socket.emit('data',Buffer.from('221 bye\r\n'))
      })};setImmediate(()=>socket.emit('data',Buffer.from('220 fixture\r\n')));return socket}}}
    const filename=path.join(root,'lib/legacySmtpVerifier.js'),mod={exports:{}};const req=name=>mocks[name];req.resolve=()=>'/fixture/email-verify/index.js'
    vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:mod,exports:mod.exports,require:req,console})
    const result=await new Promise((resolve,reject)=>mod.exports.verify('user250@example.test',{},(e,r)=>e?reject(e):resolve(r)))
    return {result,commands}}
  const accepted=await scenario('accepted');assert(accepted.result.success);assert.strictEqual(accepted.result.rcptReplyCode,250);assert.strictEqual(accepted.commands.filter(x=>x==='MAIL').length,1)
  const refused=await scenario('refused');assert.strictEqual(refused.result.success,false);assert.strictEqual(refused.result.rcptReplyCode,550)
  for(const mode of ['early','mail-denied']){const r=await scenario(mode);assert(r.result.tryagain);assert.strictEqual(r.result.rcptReplyCode,null);assert(!r.commands.includes('RCPT'))}
  const temporary=await scenario('temporary');assert(temporary.result.tryagain);assert.strictEqual(temporary.result.rcptReplyCode,450)
})
test('legacy verifier offline evidence: 550 refusal containing 250 in address is misclassified', async () => {
  const filename=path.join(__dirname,'legacy-email-verify.js'),module={exports:{}};let socket
  const noop=()=>{}
  const mocks={validator:{isEmail:()=>true},dns:{resolveMx:(d,cb)=>cb(null,[{priority:10,exchange:'fixture.invalid'}])},
    net:{createConnection:()=>{socket=new EventEmitter();socket.setTimeout=noop;socket.destroy=noop;socket.end=()=>setImmediate(()=>socket.emit('end'));socket.write=(text,cb)=>{if(cb)cb();setImmediate(()=>socket.emit('data',Buffer.from(text.startsWith('RCPT')?'550 user250@example.test does not exist\r\n':text.startsWith('QUIT')?'221 bye\r\n':'250 OK\r\n')))};setImmediate(()=>socket.emit('data',Buffer.from('220 fixture\r\n')));return socket}},
    './logger.js':{logger:{info:noop,server:noop,client:noop,error:noop}}}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,require:name=>mocks[name],console})
  const info=await new Promise((resolve,reject)=>module.exports.verify('user250@example.test',{},(error,value)=>error?reject(error):resolve(value)))
  assert.strictEqual(info.success,true);assert.strictEqual(info.code,1)
})
test('HTTP startup is independent of a Google DNS probe', async () => {
  let listens=0;const app={use:()=>{}};const express=()=>app;express.static=()=>()=>{}
  const server={listen:(port,fn)=>{listens++;fn()},address:()=>({port:3000})}
  load('app.js',{express,'body-parser':{json:()=>()=>{},urlencoded:()=>()=>{}},http:{createServer:()=>server},'socket.io':()=>({}),
    './lib/setExpressRouter':()=>{},'./lib/setIOEvents':()=>{},'./lib/mail':class Mail{},'./lib/mongo':async()=>({}),'./config':{APP_PORT:3000},debug:()=>()=>{}})
  await sleep(5);assert.strictEqual(listens,1)
})
test('PM2 keeps one process with production file watching disabled', () => {
  const pm=JSON.parse(fs.readFileSync(path.join(root,'pm2.json'))).apps[0]
  assert.strictEqual(pm.watch,false);assert(pm.ignore_watch.includes('maintenance-state'));assert.strictEqual(pm.instances,'1')
})

;(async()=>{const results=[];for(const t of tests){try{await t.fn();results.push({name:t.name,pass:true})}catch(e){results.push({name:t.name,pass:false,error:e.stack});console.log(JSON.stringify({node:process.version,results},null,2));process.exitCode=1;return}}console.log(JSON.stringify({node:process.version,network:'isolated; no production DB/SMTP',results},null,2))})().catch(e=>{console.error(e);process.exitCode=1})
