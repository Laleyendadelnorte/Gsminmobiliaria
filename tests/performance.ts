import {chromium} from 'playwright-core';
import {mkdir,writeFile} from 'node:fs/promises';
const access=process.env.GCM_ACCESS_URL;if(!access)throw new Error('GCM_ACCESS_URL required');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,proxy:process.env.BROWSER_PROXY?{server:process.env.BROWSER_PROXY}:undefined,args:['--no-sandbox','--disable-dev-shm-usage']});
try{
 const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true});const page=await context.newPage();
 await page.goto(access);await page.getByRole('heading',{name:'Todo comienza con una buena conexión.'}).waitFor();
 await page.addInitScript(()=>{(window as any).__lcp=0;new PerformanceObserver(list=>{for(const e of list.getEntries())(window as any).__lcp=e.startTime}).observe({type:'largest-contentful-paint',buffered:true})});
 const cdp=await context.newCDPSession(page);await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true});await cdp.send('Network.emulateNetworkConditions',{offline:false,latency:150,downloadThroughput:200000,uploadThroughput:93750});await cdp.send('Emulation.setCPUThrottlingRate',{rate:4});
 const samples=[];
 for(let i=0;i<3;i++){await page.goto(process.env.APP_URL||'http://localhost:3000');await page.getByRole('heading',{name:'Todo comienza con una buena conexión.'}).waitFor();await page.waitForTimeout(6000);samples.push(await page.evaluate(()=>({lcpMs:Math.round((window as any).__lcp),ttfbMs:Math.round((performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).responseStart),transferBytes:performance.getEntriesByType('resource').reduce((n,r)=>n+(r as PerformanceResourceTiming).transferSize,0)})));}
 const median=[...samples].sort((a,b)=>a.lcpMs-b.lcpMs)[1].lcpMs;const result={date:new Date().toISOString(),route:'authenticated dashboard',viewport:'390x844',cpuSlowdown:4,network:'1.6 Mbps down / 0.75 Mbps up / 150ms emulated latency, through HTTPS relay',cache:'disabled',samples,medianLcpMs:median,targetLcpMs:2500,targetMet:median<=2500};
 await mkdir('artifacts',{recursive:true});await writeFile('artifacts/performance.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser.close()}
