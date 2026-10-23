import {readFile,writeFile} from 'node:fs/promises';
import {keywordSources,complementaryKeywordSources} from '../lib/keyword-feeds.mjs';
const file=process.argv[2]||'config/rss-keywords.json';
const library=JSON.parse(await readFile('reports/source-research/keyword-library.json','utf8'));
let old={sources:[]};try{old=JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
const previous=new Map(old.sources.map(s=>[s.id,s]));
const translations=JSON.parse(await readFile('config/keyword-translations.en.json','utf8'));
const generated=process.argv.includes('--complement')?complementaryKeywordSources(library,translations):keywordSources(library);
const sources=generated.map(s=>{const p=previous.get(s.id);return p?.searchQuery===s.searchQuery?{...s,...p}:s;});
const result={schemaVersion:1,baseUrl:'http://127.0.0.1:1200',library:'reports/source-research/keyword-library.json',
  generatedAt:new Date().toISOString(),sourceKind:'keyword_search_not_independent_publishers',excludedSourceIds:[],sources};
await writeFile(file,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({keywords:sources.length,groups:library.groups.length,file}));
