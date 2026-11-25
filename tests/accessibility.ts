import {chromium} from 'playwright-core';
import AxeBuilder from '@axe-core/playwright';
import {mkdir,writeFile} from 'node:fs/promises';
const access=process.env.GCM_ACCESS_URL;if(!access)throw new Error('GCM_ACCESS_URL required');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,proxy:process.env.BROWSER_PROXY?{server:process.env.BROWSER_PROXY}:undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
const context=await browser.newContext({viewport:{width:1440,height:1000},locale:'es-DO'});const page=await context.newPage();const reports=[];
try{
 await page.goto(access);await page.getByRole('heading',{name:'Todo comienza con una buena conexión.'}).waitFor();
 for(const section of ['inicio','propiedades','prospectos','asistente','portales','visitas','pagos','actividad','configuracion']){
  await page.goto((process.env.APP_URL||'http://localhost:3000')+'/?section='+section);await page.locator('main h1').waitFor();await page.waitForTimeout(250);
  const report=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();reports.push({section,violations:report.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary}))}))});
 }
 const call=async(path:string,body?:unknown)=>page.evaluate(async({path,body})=>{const r=await fetch('/api/'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});if(!r.ok)throw new Error('Portal QA API '+r.status);return r.json()},{path,body});
 const people=await call('prospects?q=Alejandro');const props=await call('properties?status=PUBLICADA');
 const draft=await call('offers',{prospectId:people.items[0].id,propertyIds:props.items.slice(0,3).map((p:{id:string})=>p.id),title:'QA accesibilidad',greeting:'Hola, Alejandro'});
 const publication=await call('offers/'+draft.id+'/publish',{approved:true});const data={id:draft.id,url:publication.url};
 try{const client=await browser.newContext({viewport:{width:390,height:844}});const p=await client.newPage();await p.goto(data.url);await p.getByRole('heading',{name:'Tu selección de propiedades'}).waitFor();
 const r=await new AxeBuilder({page:p}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();reports.push({section:'portal-mobile',violations:r.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary}))}))});
 await p.getByRole('button',{name:'Conocer la propiedad'}).first().click();const modal=await new AxeBuilder({page:p}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();reports.push({section:'visit-modal',violations:modal.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,nodes:v.nodes.map(n=>({target:n.target,html:n.html,summary:n.failureSummary}))}))});await client.close();
 }finally{await page.evaluate(async id=>{await fetch('/api/offers/'+id+'/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})},data.id)}
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/accessibility.json',JSON.stringify(reports,null,2));console.log(JSON.stringify(reports.map(r=>({section:r.section,violations:r.violations.map(v=>({id:v.id,nodes:v.nodes.length}))}))));
 if(reports.some(r=>r.violations.length))process.exitCode=1;
}finally{await browser.close()}
