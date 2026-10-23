import {discover as discoverFeeds,hydrate as hydrateFeeds} from './feeds.mjs';
export const discover=discoverFeeds;

export async function hydrate(candidate,source,ctx) {
  const paper=candidate.url?.match(/^https?:\/\/(?:www\.)?arxiv\.org\/abs\/([^?#]+)/);
  if(paper && source.role==='RESEARCH_PREPRINT') {
    const api='https://export.arxiv.org/api/query?id_list='+encodeURIComponent(paper[1]);
    const response=await ctx.http.get(api,{cacheMs:86400000}),$=ctx.html.load(response.text,{xmlMode:true}),entry=$('entry').first();
    const published=entry.find('published').text(),updated=entry.find('updated').text(),title=entry.find('title').text().replace(/\s+/g,' ').trim();
    const content=entry.find('summary').text().replace(/\s+/g,' ').trim(),id=entry.find('id').text();
    if(!id.includes('/abs/'+paper[1].replace(/v\d+$/,'')) || !Number.isFinite(Date.parse(published)) || !content)throw new Error('Original arXiv entry/body/date missing');
    const url=id.replace(/^http:/,'https:');
    return {sourceId:source.id,channelId:'primary',sourceItemId:candidate.id,title,url,publishedAt:new Date(published).toISOString(),publishedAtRaw:published,datePrecision:'second',
      content,contentFormat:'text',evidenceClass:'preprint',evidence:[{url,kind:'preprint',relation:'original',title}],
      authors:entry.find('author > name').toArray().map(n=>$(n).text()),topics:['robotics'],metadata:{...candidate.metadata,sourceRole:source.role,
        arxivId:paper[1].replace(/v\d+$/,''),arxivUpdatedAt:updated,arxivOriginalPublishedAt:published,originalPublishedAt:published,originalDatePrecision:'second'},
      raw:{url:api,mediaType:'application/atom+xml',content:response.text}};
  }
  const match=candidate.url?.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/releases\/tag\/(.+?)(?:[?#]|$)/);
  if(match && source.githubRepo?.toLowerCase()===match[1].toLowerCase()) {
    const api=`https://api.github.com/repos/${match[1]}/releases/tags/${encodeURIComponent(decodeURIComponent(match[2]))}`;
    const response=await ctx.http.get(api,{headers:{Accept:'application/vnd.github+json'}}),release=JSON.parse(response.text);
    if(release.draft || !release.published_at || !release.body?.trim())throw new Error('Release has no published original body/date');
    return {sourceId:source.id,channelId:'primary',sourceItemId:candidate.id,title:release.name||release.tag_name,url:release.html_url,
      publishedAt:release.published_at,publishedAtRaw:release.published_at,datePrecision:'second',content:release.body,contentFormat:'text',
      evidenceClass:'repository',evidence:[{url:release.html_url,kind:'repository',relation:'original',title:release.name}],
      authors:[release.author?.login].filter(Boolean),topics:['robotics'],metadata:{...candidate.metadata,sourceRole:source.role,releaseTag:release.tag_name,
        releasePrerelease:release.prerelease,originalPublishedAt:release.published_at,originalDatePrecision:'second',releaseApiPublishedAt:release.published_at,releaseDateEvidenceUrl:api},
      raw:{url:api,mediaType:'application/json',content:response.text}};
  }
  // Feed-only text and community discussions remain discovery leads until their
  // original evidence is retrieved; no generated RSS body is labeled first-hand.
  if(/DISCOVERY/.test(source.role))throw new Error('Discovery source: retrieve a distinct original evidence page before qualification');
  const item=await hydrateFeeds(candidate,source,ctx);
  if(!item.metadata.originalPublishedAt) {
    const host=u=>new URL(u).hostname.replace(/^www\./,'');
    const originalFeed=!source.route && source.entryUrl && host(source.entryUrl)===host(candidate.url)
      && host(source.website)===host(candidate.url) && candidate.datePrecision==='second';
    if(!originalFeed)throw new Error('Original page date still needs verification');
    // A publisher's own timestamped RSS is primary date evidence. Keep that
    // distinction explicit; a generated RSSHub timestamp cannot use this path.
    item.metadata.originalPublishedAt=candidate.publishedAt;
    item.metadata.originalPublishedAtRaw=candidate.publishedAtRaw;
    item.metadata.originalDatePrecision='second';
    item.metadata.dateEvidenceUrl=source.entryUrl;
    item.metadata.dateEvidenceBasis='publisher-native-feed';
  }
  item.publishedAt=item.metadata.originalPublishedAt;
  item.publishedAtRaw=item.metadata.originalPublishedAtRaw;
  item.datePrecision=item.metadata.originalDatePrecision;
  item.metadata.sourceRole=source.role;
  if(source.role==='RESEARCH_PAPER')item.evidenceClass='paper';
  if(source.role==='RESEARCH_PREPRINT')item.evidenceClass='preprint';
  if(['ENGINEERING_AUTHOR','PROJECT_UPDATES'].includes(source.role))item.evidenceClass='project';
  for(const e of item.evidence)if(e.relation==='original')e.kind=item.evidenceClass;
  return item;
}
