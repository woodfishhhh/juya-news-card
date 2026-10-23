import Parser from 'rss-parser';
import {createHash} from 'node:crypto';
import {withFeedIntake} from '../lib/feed-intake.mjs';
import {articleUrl,excludedPublisher,keywordRelevant} from '../lib/keyword-feeds.mjs';
const parser=new Parser({customFields:{item:[['News:Source','newsSource'],['source','source']]}});
export async function discover(source,ctx) {return withFeedIntake(source,ctx,search);}
async function search(source,ctx) {
  const candidates=[],issues=[],coverage={pagesFetched:0,entryUrl:source.entryUrl,attempts:[],filteredOut:0,excludedPublishers:0,keyword:source.keywords[0],searchQuery:source.searchQuery};
  const seen=new Set();
  for(const url of [source.entryUrl,...source.fallbackUrls??[]]) {
    try {
      const response=await ctx.http.get(url,{timeoutMs:20000}),feed=await parser.parseString(response.text);
      coverage.pagesFetched++;coverage.itemCount=(coverage.itemCount??0)+feed.items.length;
      coverage.attempts.push({url,status:response.status,items:feed.items.length});
      for(const item of feed.items) {
        let target;try{target=articleUrl(item.link);}catch{coverage.filteredOut++;continue;}
        const publisher=typeof item.source==='string'?item.source:item.source?._||item.newsSource||'';
        const publisherUrl=item.source?.$?.url||target;
        if(excludedPublisher(target,publisher)||excludedPublisher(publisherUrl,publisher)){coverage.excludedPublishers++;continue;}
        const summary=ctx.html.text(item.contentSnippet||item.content||item.description||'');
        if(!keywordRelevant(item.title??'',summary,source)){coverage.filteredOut++;continue;}
        // Query/market tracking is never the article's durable identity.
        if(seen.has(target))continue;seen.add(target);
        const raw=item.pubDate||item.isoDate||'',date=ctx.html.date(raw);
        const id=createHash('sha256').update(target).digest('hex').slice(0,24);
        candidates.push({id:`${source.id}:${id}`,url:target,title:item.title||target,...date,channelId:'primary',
          metadata:{feedId:source.id,feedUrl:url,discoveryUrl:item.link,summary,publisher,publisherUrl,
            keywordGroup:source.keywordGroup,keywords:source.keywords,searchQuery:source.searchQuery,
            sourceRole:'KEYWORD_DISCOVERY',searchTimestampUnverified:true,originalEvidenceRequired:true}});
      }
      if(candidates.length){coverage.selectedFeed=url;break;}
    }catch(e){issues.push({kind:'search-feed',url,error:String(e.message)});coverage.attempts.push({url,error:String(e.message)});}
  }
  return {candidates,issues,coverage};
}
export async function hydrate() {throw new Error('Keyword search lead only: retrieve original article, date and evidence before qualification');}
