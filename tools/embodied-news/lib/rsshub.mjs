import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {publicFeedUrl} from './feed-intake.mjs';

export function resolveSubscriptions(config) {
  const base=publicFeedUrl(config.baseUrl).replace(/\/$/,'');
  return config.sources.filter(s=>s.enabled).map(s=>{
    if (config.excludedSourceIds?.includes(s.id)) throw new Error('Excluded RSS source cannot be enabled: '+s.id);
    if (s.route && (!s.route.startsWith('/') || s.route.startsWith('//'))) throw new Error('RSSHub route must be an absolute path');
    return {...s,adapter:s.adapter??'rsshub',entryUrl:publicFeedUrl(s.route ? base+s.route : s.entryUrl),channelId:'primary'};
  });
}
export async function configuredSources(config,configPath) {
  const files=[config.rsshubConfig,config.publisherFeedConfig,config.domesticFeedConfig,...config.keywordFeedConfigs??[]].filter(Boolean);
  const extra=[];
  for(const file of files)extra.push(...resolveSubscriptions(JSON.parse(await readFile(resolve(dirname(configPath),file),'utf8'))));
  const ids=new Set(config.sources.map(s=>s.id));
  for(const source of extra){if(ids.has(source.id))throw new Error('Duplicate configured source: '+source.id);ids.add(source.id);}
  return [...config.sources,...extra];
}
