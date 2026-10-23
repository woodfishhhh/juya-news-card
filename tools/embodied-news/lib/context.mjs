import { mkdir, writeFile,readFile,rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join,resolve } from 'node:path';
import * as html from './html.mjs';
import { ProxyAgent } from 'undici';
import {loadPublicDomBundle} from './public-dom.mjs';

export async function createContext({ workDir = 'work',cacheDir = join(workDir,'cache'), maxPages = 3, timeoutMs = 25000, retries = 2, limit = 5,hostIntervals={},forceRefresh=false } = {}) {
  await mkdir(workDir, { recursive: true });
  const requests = [];
  const publicDom = process.env.EMBODIED_PUBLIC_DOM_BUNDLE ? await loadPublicDomBundle(process.env.EMBODIED_PUBLIC_DOM_BUNDLE) : null;
  const blockedHosts = new Set((process.env.EMBODIED_BLOCKED_HOSTS || '').split(',').map(h=>h.trim().toLowerCase()).filter(Boolean));
  const lastHost = new Map();
  const hostBackoff = new Map();
  const intervals={'export.arxiv.org':3000,...hostIntervals};
  let browser;
  let bilibili;
  const proxyUrl = process.env.EMBODIED_PROXY === 'none' ? null : (process.env.EMBODIED_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY);
  const proxy = proxyUrl ? new ProxyAgent(proxyUrl) : null;
  const useProxy = url => proxy && !['localhost','127.0.0.1','::1'].includes(new URL(url).hostname) && !(process.env.NO_PROXY || '').split(',').filter(Boolean).some(domain=>new URL(url).hostname.endsWith(domain.trim().replace(/^\./,'')));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function snapshot(result) {
    if (result.headers) result.headers=Object.fromEntries(Object.entries(result.headers).filter(([key])=>!['set-cookie','cookie','authorization','proxy-authorization'].includes(key.toLowerCase())));
    const digest=createHash('sha256').update(result.text).digest('hex');
    await mkdir(join(workDir,'responses'),{recursive:true});
    await writeFile(join(workDir,'responses',digest+'.txt'),result.text,'utf8');
    result.snapshotPath=join('responses',digest+'.txt');
    return result;
  }
  async function request(url, options = {}, activeSourceId = null) {
    const host = new URL(url).host;
    if([...blockedHosts].some(h=>new URL(url).hostname===h || new URL(url).hostname.endsWith('.'+h))){requests.push({url,networkAttempt:false,policyBlocked:true,at:new Date().toISOString()});throw new Error('Evidence host is blocked by the current cloud network policy: '+new URL(url).hostname);}
    if(publicDom?.handles(url)){
      if(activeSourceId!==publicDom.sourceId)throw new Error('Public DOM capture source does not match the active collector source');
      if(options.method && options.method!=='GET')throw new Error('Public DOM bridge only supports read-only GET observations');
      const result=await snapshot(publicDom.get(url));
      requests.push({url,publicDom:true,publicDomSourceId:publicDom.sourceId,networkAttempt:false,observedAt:result.observedAt,observationDigest:result.observationDigest,snapshotPath:result.snapshotPath,at:new Date().toISOString()});
      return result;
    }
    const cachePath=join(cacheDir,createHash('sha256').update(url).digest('hex')+'.json');
    const cacheMs=forceRefresh || options.method || options.headers?.authorization || options.headers?.Authorization || options.headers?.cookie || options.headers?.Cookie ? 0 : Number(options.cacheMs || 0);
    if(cacheMs>0){try{const cached=JSON.parse(await readFile(cachePath,'utf8'));if(Date.now()-cached.at<cacheMs){requests.push({url,status:cached.result.status,cache:true,at:new Date().toISOString()});return await snapshot(cached.result);}}catch(e){if(e.code!=='ENOENT' && !(e instanceof SyntaxError))throw e;}}
    const blockedUntil=hostBackoff.get(host);
    if(blockedUntil && blockedUntil>Date.now()){
      const retryAt=new Date(blockedUntil).toISOString();
      requests.push({url,networkAttempt:false,rateLimited:true,retryAt,at:new Date().toISOString()});
      throw Object.assign(new Error('Source host rate limited until '+retryAt),{rateLimited:true,retryAt});
    }
    let last;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const gap=(intervals[host] ?? 350)-(Date.now()-(lastHost.get(host)||0));if(gap>0)await sleep(gap);
      const started = Date.now();
      try {
        lastHost.set(host, Date.now());
        const response = await fetch(url, { ...options, ...(useProxy(url) ? {dispatcher:proxy} : {}), headers: { 'user-agent': 'EmbodiedDaily/0.1 (public research collector)', accept: '*/*', ...options.headers }, signal: AbortSignal.timeout(options.timeoutMs || timeoutMs) });
        const body = await response.text();
        const result = await snapshot({ text: body, url: response.url, status: response.status, headers: Object.fromEntries(response.headers) });
        requests.push({ url, finalUrl: response.url, status: response.status, attempt, at: new Date(started).toISOString(), elapsedMs: Date.now() - started,snapshotPath:result.snapshotPath });
        if (response.ok) {
          if(cacheMs>0){await mkdir(cacheDir,{recursive:true});const temp=cachePath+'.tmp';await writeFile(temp,JSON.stringify({at:Date.now(),result}),'utf8');await rename(temp,cachePath);}
          return result;
        }
        last = Object.assign(new Error(`HTTP ${response.status}: ${url}`), { status: response.status, response: result });
        const reset=Number(response.headers.get('x-ratelimit-reset'))*1000;
        if(response.status===403 && response.headers.get('x-ratelimit-remaining')==='0' && reset>Date.now()){
          last.retryAt=new Date(reset).toISOString();last.rateLimited=true;hostBackoff.set(host,reset);break;
        }
        if (![408, 429, 500, 502, 503, 504].includes(response.status)) break;
        const retryAfter = response.headers.get('retry-after');
        const headerWait=retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter)*1000 : retryAfter ? Math.max(0,Date.parse(retryAfter)-Date.now()) : 0;
        const wait=headerWait || 1000*2**attempt;
        if(headerWait>15000){const until=Date.now()+headerWait;last.retryAt=new Date(until).toISOString();last.rateLimited=true;hostBackoff.set(host,until);break;}
        if (attempt < retries) await sleep(wait);
      } catch (error) {
        last = error;
        requests.push({ url, attempt, error: error.message, at: new Date(started).toISOString(), elapsedMs: Date.now() - started });
        if (attempt < retries) await sleep(1000 * 2 ** attempt);
      }
    }
    throw last;
  }
  async function browserGet(url, options = {}, sourceId = null) {
      if([...blockedHosts].some(h=>new URL(url).hostname===h || new URL(url).hostname.endsWith('.'+h)))return request(url,options,sourceId);
      if(publicDom?.handles(url))return request(url,options,sourceId);
      if((process.env.EMBODIED_BROWSER_TRANSPORT ?? 'ego-only') === 'ego-only') throw new Error('Browser rendering requires EGO lite; record this gap and collect the public page through ego-browser.');
      if (!browser) {
        const { chromium } = await import('playwright');
        const proxyConfig = proxyUrl ? new URL(proxyUrl) : null;
        browser = await chromium.launch({ headless: true, ...(proxyConfig ? {proxy:{server:`${proxyConfig.protocol}//${proxyConfig.host}`, ...(proxyConfig.username ? {username:decodeURIComponent(proxyConfig.username),password:decodeURIComponent(proxyConfig.password)} : {})}} : {}), ...(process.env.EMBODIED_CHROME_PATH ? { executablePath: process.env.EMBODIED_CHROME_PATH } : {}) });
      }
      const page = await browser.newPage();
      try {
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: options.timeoutMs || timeoutMs });
        if (options.waitForSelector) await page.waitForSelector(options.waitForSelector, { timeout: options.timeoutMs || timeoutMs });
        await page.waitForTimeout(options.waitMs ?? 1500);
        const result = await snapshot({ text: await page.content(), url: page.url(), status: response?.status() || 0, headers: response ? await response.allHeaders() : {} });
        requests.push({ url, finalUrl: result.url, status: result.status, browser: true, at: new Date().toISOString(),snapshotPath:result.snapshotPath });
        if (result.status >= 400) throw Object.assign(new Error(`Browser HTTP ${result.status}: ${url}`), { status: result.status, response: result });
        return result;
      } finally { await page.close(); }
  }
  const ctx = {
    forSource(sourceId) {
      const scoped={...ctx,
        http:{get:(url,options)=>request(url,options,sourceId),post:(url,body,options={})=>request(url,{...options,method:'POST',body:typeof body==='string'?body:JSON.stringify(body),headers:{'content-type':'application/json',...options.headers}},sourceId)},
        browser:{get:(url,options)=>browserGet(url,options,sourceId)}
      };
      delete scoped.forSource;
      return scoped;
    },
    publicDomCapture: publicDom ? {sourceId:publicDom.sourceId,capturedAt:publicDom.capturedAt,oldestObservedAt:publicDom.oldestObservedAt,digest:publicDom.digest,method:publicDom.method} : null,
    now: new Date().toISOString(), workDir, maxPages, limit, html, requests,forceRefresh,
    http: { get: (url, options) => request(url, options), post: (url, body, options = {}) => request(url, { ...options, method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...options.headers } }) },
    browser: { get: (url,options)=>browserGet(url,options) },
    accounts: process.env.EMBODIED_BILIBILI_PROFILE_DIR ? {bilibili:{async get(url) {
      if(!/(^|\.)bilibili\.com$/.test(new URL(url).hostname)) throw new Error('Bilibili account context only allows bilibili.com');
      if((process.env.EMBODIED_BROWSER_TRANSPORT ?? 'ego-only') === 'ego-only') throw new Error('Authenticated browser access requires EGO lite and the existing user session.');
      if(!bilibili){
        const {chromium}=await import('playwright');
        const accountProxy = proxyUrl ? new URL(proxyUrl) : null;
        bilibili=await chromium.launchPersistentContext(resolve(process.env.EMBODIED_BILIBILI_PROFILE_DIR),{
          headless:true,
          ...(accountProxy ? {proxy:{server:`${accountProxy.protocol}//${accountProxy.host}`,
            ...(accountProxy.username ? {username:decodeURIComponent(accountProxy.username),password:decodeURIComponent(accountProxy.password)} : {})}} : {}),
          ...(process.env.EMBODIED_CHROME_PATH?{executablePath:process.env.EMBODIED_CHROME_PATH}:{})
        });
      }
      let response;
      try { response=await bilibili.request.get(url,{timeout:timeoutMs,headers:{referer:'https://www.bilibili.com/'}}); }
      catch(error) { throw new Error('Authenticated Bilibili request failed: ' + String(error.message).split('\n')[0]); }
      const result={text:await response.text(),url:response.url(),status:response.status(),headers:response.headers()};
      // Authenticated navigation responses contain account identifiers. Keep them in memory only.
      requests.push({url,status:result.status,authenticatedContext:'bilibili',at:new Date().toISOString()});
      if(result.status>=400)throw new Error(`Authenticated Bilibili HTTP ${result.status}`);
      return result;
    }}} : {},
    async close() { if (browser) await browser.close(); if(bilibili)await bilibili.close(); if(proxy) await proxy.close(); await writeFile(join(workDir, `requests-${createHash('sha256').update(ctx.now).digest('hex').slice(0, 12)}.json`), JSON.stringify(requests, null, 2)); }
  };
  return ctx;
}
