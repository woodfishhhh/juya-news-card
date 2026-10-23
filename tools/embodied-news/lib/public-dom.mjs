import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const SOURCES={
 'agibot-news':{hosts:['www.agibot.com','agibot.com'],paths:/^\/(?:news\/?|News\/?|article\/\d+\/detail\/\d+\.html)$/},
};
function time(value){const n=Date.parse(value);if(!Number.isFinite(n))return null;const canonical=new Date(n).toISOString();return value===canonical || value===canonical.replace('.000Z','Z')?n:null;}
function safeUrl(value,scope){const u=new URL(value);if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||!scope.hosts.includes(u.hostname)||!scope.paths.test(u.pathname)||[...u.searchParams.entries()].some(([k,v])=>k!=='page'||!/^news\/?$/i.test(u.pathname.slice(1))||!(/^[1-9]\d*$/.test(v)))||u.searchParams.getAll('page').length>1)throw new Error('Public DOM URL is outside the configured public-source scope');return u.href;}
export async function loadPublicDomBundle(file,{now=Date.now(),maxAgeMs=600000}={}){
 const raw=await readFile(file,'utf8');const data=JSON.parse(raw);const scope=SOURCES[data.sourceId];
 if(Object.keys(data).some(key=>!['schemaVersion','method','sourceId','capturedAt','pages'].includes(key)))throw new Error('Public DOM bundle contains non-public-schema fields');
 if(!scope||data.schemaVersion!==1||data.method!=='supported-cloud-browser-public-dom-html')throw new Error('Unsupported public DOM source bundle');
 const capture=time(data.capturedAt);if(capture===null||capture>now+60000||now-capture>maxAgeMs)throw new Error('Fresh supported-browser DOM capture required');
 if(!Array.isArray(data.pages)||!data.pages.length)throw new Error('Public DOM bundle has no pages');
 const pages=new Map();
 for(const page of data.pages){
  if(Object.keys(page).some(key=>!['url','requestedUrl','observedAt','html','pageTitle','selector'].includes(key)))throw new Error('Public DOM page contains non-public-schema fields');
  const url=safeUrl(page.url,scope);const at=time(page.observedAt);
  if(at===null||at>capture||capture-at>maxAgeMs)throw new Error('Page observation time is missing, stale, or after bundle capture');
  if(typeof page.html!=='string'||page.html.trim().length<30||page.html.length>5000000)throw new Error('Missing or excessive public DOM HTML');
  if(pages.has(url))throw new Error('Duplicate public DOM page URL');
  const record={url,observedAt:page.observedAt,html:page.html};
  pages.set(url,record);
  if(page.requestedUrl){const requested=safeUrl(page.requestedUrl,scope);if(requested!==url){if(pages.has(requested))throw new Error('Ambiguous observed redirect URL');pages.set(requested,record);}}
 }
 const digest=createHash('sha256').update(raw).digest('hex');
 return {sourceId:data.sourceId,capturedAt:data.capturedAt,oldestObservedAt:new Date(Math.min(...data.pages.map(page=>time(page.observedAt)))).toISOString(),digest,method:data.method,
  handles(url){return scope.hosts.includes(new URL(url).hostname);},
  get(url){const target=safeUrl(url,scope);const page=pages.get(target);if(!page)throw new Error('Public page needs a fresh supported-browser capture: '+target);
   if(Date.now()-time(page.observedAt)>maxAgeMs)throw new Error('Public DOM page capture expired during collection');
   return {url:page.url,text:page.html,status:0,headers:{'content-type':'text/html'},publicDom:true,observedAt:page.observedAt,observationDigest:digest};}
 };
}
