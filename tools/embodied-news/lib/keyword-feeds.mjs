import {createHash} from 'node:crypto';
import {publicFeedUrl} from './feed-intake.mjs';

const contexts={technology:'(robot OR robotics OR embodied OR 机器人)',hardware:'(机器人 OR 电机 OR robotics)',companies_capital:'(机器人 OR humanoid OR robotics)',deployment:'(机器人 OR robotics)',data:'(机器人 OR robotics)',policy:'(机器人 OR robotics)',engineering_competitions:'(机器人 OR robotics OR 电子设计 OR 开源硬件)'};
const aliases={
  'Figure':'Figure humanoid robot','Helix':'Figure Helix robot','BMW部署':'BMW humanoid robot factory',
  'Tesla Optimus':'Tesla Optimus','Gen 3':'Tesla Optimus Gen 3','弗里蒙特工厂':'Tesla Optimus Fremont factory',
  'FIRST':'FIRST Robotics competition','FRC':'FIRST Robotics FRC','WAM':'world action model robot',
  'WRAM':'world reasoning action model robot','WBI':'whole body intelligence robot','Agent+Skill':'robot agent skill',
  '全国70+座':'机器人 训练场','在建46座':'机器人 训练场 在建','千万小时级数据缺口':'机器人 数据 采集 规模',
  '万台交付':'机器人 交付','百亿估值':'机器人 公司 融资 估值','万台级规模落地能力':'机器人 规模 部署',
  '国家人形机器人产业标准体系建设指南（2026版）':'人形机器人 标准体系 建设指南',
  '人形机器人产量突破10万台':'人形机器人 产量 统计','整机产品400+款':'人形机器人 整机 产品',
  'Sim-to-Real迁移成功率≥95%':'robot sim-to-real transfer success benchmark',
  '人机协作动态风险响应时间<50ms':'人机协作 安全 风险 响应 标准',
};
export function keywordQuery(term,group) {
  if(aliases[term])return aliases[term];
  return `"${term.replaceAll('"','')}" ${contexts[group]??contexts.technology}`;
}
export function searchUrls(query,english=false) {
  const bing=new URL('https://www.bing.com/news/search');bing.searchParams.set('q',query);bing.searchParams.set('format','rss');bing.searchParams.set('mkt',english?'en-US':'zh-CN');
  const google=new URL('https://news.google.com/rss/search');google.searchParams.set('q',query);google.searchParams.set('hl',english?'en-US':'zh-CN');google.searchParams.set('gl',english?'US':'CN');google.searchParams.set('ceid',english?'US:en':'CN:zh-Hans');
  return [bing.href,google.href];
}
export function keywordSources(library) {
  const seen=new Set(),sources=[];
  for(const group of library.groups)for(const term of group.terms) {
    if(seen.has(term))continue;seen.add(term);
    const searchQuery=keywordQuery(term,group.id),urls=searchUrls(searchQuery,!/[\u3400-\u9fff]/.test(term));
    sources.push({id:`keyword-${group.id}-${createHash('sha256').update(term).digest('hex').slice(0,10)}`,
      name:`关键词 · ${term}`,publisher:'News search aggregation',adapter:'keyword-search',transport:'keyword_search',
      keywordGroup:group.id,keywords:[term],searchQuery,entryUrl:urls[0],fallbackUrls:urls.slice(1),website:'https://www.bing.com/news',
      locale:!/[\u3400-\u9fff]/.test(term)?'en-US':'zh-CN',
      role:'KEYWORD_DISCOVERY',discoveryOnly:true,enabled:false,verification:{status:'not_checked'},
      claimBoundary:'User keywords are search hints; quantities, company claims and policy names are not verified facts'});
  }
  return sources;
}
export function complementaryKeywordSources(library,translations) {
  return keywordSources(library).map(source=>{
    const term=source.keywords[0],english=source.locale==='zh-CN';
    if(english&&!translations[term])throw new Error('Missing English keyword translation: '+term);
    const query=english?`${translations[term]} (robot OR robotics OR embodied)`:`"${term}" ${contexts[source.keywordGroup]}`;
    const urls=searchUrls(query,english);
    return {...source,id:source.id.replace('keyword-',english?'keyword-en-':'keyword-zh-'),
      name:`关键词 · ${term} · ${english?'海外':'国内'}`,locale:english?'en-US':'zh-CN',
      searchQuery:query,entryUrl:urls[0],fallbackUrls:urls.slice(1)};
  });
}
export const EXCLUDED_HOSTS=['jiqizhixin.com','limxdynamics.com','pi.website'];
export function articleUrl(value) {
  const u=new URL(publicFeedUrl(value));
  if(/(^|\.)bing\.com$/.test(u.hostname)&&u.pathname==='/news/apiclick.aspx'&&u.searchParams.get('url'))return publicFeedUrl(u.searchParams.get('url'));
  return u.href;
}
export function excludedPublisher(url,publisher='') {
  let host='';try{host=new URL(url).hostname;}catch{return true;}
  return EXCLUDED_HOSTS.some(h=>host===h||host.endsWith('.'+h))||/机器之心|逐际动力|Physical Intelligence/i.test(publisher);
}
const robotics=/机器人|具身|人形|机械臂|灵巧手|四足|外骨骼|无人机|无人车|智能车|电赛|电子设计竞赛|\brobot(?:s|ics|ic)?\b|humanoid|embodied|manipulat|locomot|teleoperat|grasp|dexter|exoskeleton|\b(?:VLA|RoboMaster|RoboCup|RoboSub|RobotX|FRC|NHRL|Eurobot|PX4|ArduPilot)\b/i;
const hardware=/电机|伺服|减速器|丝杠|编码器|力矩|触觉|力觉|单片机|电路|固件|嵌入式|开源硬件|机械设计|\b(?:motor|servo|encoder|actuator|microcontroller|firmware|PCB|FPGA|STM32|FOC|PID)\b/i;
export function keywordRelevant(title,summary,source) {
  const text=title+' '+summary;
  if(robotics.test(text))return true;
  if(['hardware','engineering_competitions'].includes(source.keywordGroup)&&hardware.test(text))return true;
  return /FIRST Robotics|MATE ROV/i.test(text);
}
