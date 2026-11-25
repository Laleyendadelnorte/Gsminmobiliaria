import {db,query} from '../src/server/db';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
if(process.env.LOAD_TEST!=='1'||!/gcm_test(?:\?|$)/.test(process.env.DATABASE_URL||''))throw new Error('LOAD_TEST=1 and a disposable database ending in gcm_test are required.');
await mkdir('artifacts',{recursive:true});
const [org]=await query('INSERT INTO organizations(name) VALUES($1) RETURNING id',['SYNTHETIC LOAD '+randomUUID()]);
const [user]=await query('INSERT INTO users(email,name) VALUES($1,$2) RETURNING id',[randomUUID()+'@example.invalid','Synthetic Load']);
await query("INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,'ADMIN')",[org.id,user.id]);
await query("INSERT INTO properties(organization_id,agent_id,code,title,type,status,price_minor,currency,municipality,bedrooms) SELECT $1,$2,'LOAD-'||n,'Synthetic property '||n,'CASA','PUBLICADA',500000000+(n*10000),'DOP','Santo Domingo Este',3 FROM generate_series(1,10000)n",[org.id,user.id]);
await query("INSERT INTO prospects(organization_id,agent_id,name) SELECT $1,$2,'Synthetic prospect '||n FROM generate_series(1,10000)n",[org.id,user.id]);
await query("INSERT INTO offers(organization_id,agent_id,prospect_id,slug,title,status) SELECT $1,$2,p.id,'load-'||replace(p.id::text,'-','')||'-'||n,'Synthetic offer '||n,'PUBLICADA' FROM prospects p CROSS JOIN generate_series(1,2)n WHERE p.organization_id=$1",[org.id,user.id]);
await query("WITH o AS (SELECT id,row_number()over(order by id) n FROM offers WHERE organization_id=$1),p AS(SELECT id,row_number()over(order by id) n FROM properties WHERE organization_id=$1) INSERT INTO offer_properties(offer_id,property_id,organization_id,position) SELECT o.id,p.id,$1,x.i FROM o CROSS JOIN generate_series(0,2)x(i) JOIN p ON p.n=((o.n+x.i-1)%10000)+1",[org.id]);
const tokens=Array.from({length:100},()=>randomBytes(32).toString('hex'));
for(const token of tokens)await query("INSERT INTO sessions(organization_id,user_id,token_hash,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[org.id,user.id,createHash('sha256').update(token).digest('hex')]);
await query('ANALYZE');
const port=43173;const origin='http://127.0.0.1:'+port;const log=openSync('artifacts/load-server.log','w',0o600);
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port',String(port)],{env:{...process.env,APP_URL:origin,NODE_ENV:'production',ENABLE_BOOTSTRAP_ACCESS:'false'},stdio:['ignore',log,log]});
try{
 let ready=false;for(let n=0;n<100;n++){try{const r=await fetch(origin+'/api/health');if(r.ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100));}if(!ready)throw new Error('Isolated load server did not become ready');
 const routes=['properties?pageSize=20','prospects?pageSize=20','offers?pageSize=20','dashboard'];const results:{route:string,status:number,ms:number,valid:boolean}[]=[];const start=performance.now();
 await Promise.all(tokens.map(async token=>{for(const route of routes){const t=performance.now();try{const response=await fetch(origin+'/api/'+route,{headers:{Cookie:'gcm_session='+token},signal:AbortSignal.timeout(30000)});const data=await response.json();const expected=route.startsWith('offers')?20000:10000;results.push({route,status:response.status,ms:Math.round(performance.now()-t),valid:response.ok&&(route==='dashboard'||(data.total===expected&&data.items.length===20))});}catch{results.push({route,status:0,ms:Math.round(performance.now()-t),valid:false});}}}));
 const seconds=(performance.now()-start)/1000;const grouped=routes.map(route=>{const rows=results.filter(r=>r.route===route),ms=rows.map(r=>r.ms).sort((a,b)=>a-b);return {route,requests:rows.length,errors:rows.filter(r=>!r.valid).length,p50Ms:ms[49],p95Ms:ms[94],maxMs:ms[99]}});
 const report={date:new Date().toISOString(),dataset:{properties:10000,prospects:10000,offers:20000,offerProperties:60000},sessions:100,concurrentClients:100,requests:results.length,durationSeconds:Math.round(seconds*100)/100,requestsPerSecond:Math.round(results.length/seconds*100)/100,transport:'loopback HTTP; application and PostgreSQL on same 4GB development machine; no browser/image/LLM/payment traffic',routes:grouped,allValid:results.every(r=>r.valid)};
 await writeFile('artifacts/load.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.allValid)process.exitCode=1;
}finally{server.kill('SIGTERM');await new Promise<void>(resolve=>{if(server.exitCode!==null)return resolve();const timeout=setTimeout(()=>{server.kill('SIGKILL');resolve()},5000);server.once('close',()=>{clearTimeout(timeout);resolve()})});closeSync(log);await db.end()}
