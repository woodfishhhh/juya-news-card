#!/usr/bin/env node
// JSON payload bridge to the installed MiniMax SDK. No credential file export.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

export function validatePayload(p) {
  if (!p || typeof p.text !== 'string' || !p.text.trim() || p.text.length >= 10000) throw Error('text must contain 1-9999 characters');
  if (p.stream !== false || p.output_format !== 'hex') throw Error('Use non-streaming hex output');
  if (!p.model || !p.voice_setting?.voice_id) throw Error('Explicit model and voice required');
  const v=p.voice_setting;
  if (!(v.speed>=.5 && v.speed<=2) || !Number.isInteger(v.pitch) || v.pitch < -12 || v.pitch > 12) throw Error('Invalid speed or pitch');
  if (!(v.vol>0 && v.vol<=10)) throw Error('Invalid volume');
  if (v.emotion && !['happy','sad','angry','fearful','disgusted','surprised','calm','fluent','whisper'].includes(v.emotion)) throw Error('Unknown emotion');
  if (v.emotion && ['fluent','whisper'].includes(v.emotion) && !/^speech-2\.6-/.test(p.model)) throw Error('This emotion is only documented for speech-2.6');
  if (p.pronunciation_dict && (Array.isArray(p.pronunciation_dict) || !Array.isArray(p.pronunciation_dict.tone) || p.pronunciation_dict.tone.some(x=>typeof x!=='string'||!x.includes('/')))) throw Error('pronunciation_dict must be {tone:["word/replacement"]}');
  if (p.text_normalization_mode && !['basic','quality'].includes(p.text_normalization_mode)) throw Error('Unknown normalization mode');
  if (!p.subtitle_enable || p.subtitle_type!=='word') throw Error('Word subtitles required for alignment');
  if (p.audio_setting?.format!=='mp3') throw Error('This bridge saves MP3 only');
  for (const m of p.text.matchAll(/<#([^#]*)#>/g)) {
    if (!/^(?:\d+)(?:\.\d{1,2})?$/.test(m[1]) || +m[1]<.01 || +m[1]>99.99) throw Error('Pause must be 0.01-99.99 seconds with at most two decimals');
  }
  if (/<#[^#]*#>\s*<#/.test(p.text) || /^\s*<#/.test(p.text) || /#>\s*$/.test(p.text)) throw Error('Pause belongs between two spoken spans; do not chain pauses');
  if (/<(?:speak|break|phoneme|prosody)\b/i.test(p.text)) throw Error('Generic SSML is not supported by this bridge');
  return p;
}

async function main() {
  const args=process.argv.slice(2); const validate=args.includes('--validate');
  const value=(flag)=>{const i=args.indexOf(flag);return i<0?undefined:args[i+1];};
  const payloadPath=value('--payload');
  if (!payloadPath) throw Error('Usage: node synthesize.mjs --payload request.json [--validate | --out clip.mp3] [--region cn] [--sdk path]');
  const p=validatePayload(JSON.parse(await fs.readFile(payloadPath,'utf8')));
  const payloadHash=createHash('sha256').update(JSON.stringify(p)).digest('hex');
  if (validate) {console.log(JSON.stringify({status:'valid',payloadHash,characters:p.text.length,dictionaryRules:p.pronunciation_dict?.tone.length||0,subtitleType:p.subtitle_type}));return;}
  const out=path.resolve(value('--out')||'');
  if (!value('--out') || path.extname(out).toLowerCase()!=='.mp3') throw Error('Explicit .mp3 output required');
  const base=out.slice(0,-4), files=[out,base+'.subtitles.json',base+'.receipt.json'];
  for (const f of files) {if (await fs.stat(f).catch(()=>null)) throw Error('Refusing to overwrite an existing result');}
  const sdkPath=value('--sdk')||path.join(process.env.APPDATA||'', 'npm/node_modules/mmx-cli/dist/sdk.mjs');
  const {MiniMaxSDK}=await import(pathToFileURL(path.resolve(sdkPath)).href);
  const sdk=new MiniMaxSDK({region:value('--region')||'cn'});
  // Runtime flags only. Never log sdk.config, which contains authentication.
  Object.assign(sdk.speech.config,{nonInteractive:true,quiet:true,verbose:false,timeout:180});
  const res=await sdk.speech.synthesize(p);
  if (res.base_resp?.status_code!==0) throw Error('MiniMax rejected synthesis, status '+String(res.base_resp?.status_code));
  const hex=res.data?.audio;
  if (typeof hex!=='string' || !/^(?:[0-9a-f]{2})+$/i.test(hex)) throw Error('Missing or invalid hex audio');
  const audio=Buffer.from(hex,'hex');
  if (audio.length<100) throw Error('Empty audio');
  // Persist the paid audio before fetching subtitles, so a transient download
  // failure never forces another synthesis request.
  await fs.mkdir(path.dirname(out),{recursive:true});
  await fs.writeFile(out,audio,{flag:'wx'});
  const receipt={status:'audio_received',payloadHash,model:p.model,voice:p.voice_setting,language:p.language_boost,normalization:p.text_normalization_mode,pronunciation_dict:p.pronunciation_dict||null,subtitleType:p.subtitle_type,traceId:res.trace_id||null,audioSha256:createHash('sha256').update(audio).digest('hex'),audioBytes:audio.length,extraInfo:res.extra_info||null};
  await fs.writeFile(files[2],JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
  let subtitles=res.data?.subtitle;
  if (res.data?.subtitle_file) {
    let failure;
    for(let i=0;i<3;i++) {
      try {const r=await fetch(res.data.subtitle_file,{signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error('Subtitle HTTP '+r.status);subtitles=await r.json();failure=null;break;}catch(e){failure=e;}
    }
    if(failure)throw Error('Audio saved; subtitle download failed. Recover subtitles without repeating paid synthesis.');
  }
  if (!subtitles || (Array.isArray(subtitles)&&!subtitles.length)) throw Error('Audio saved; provider returned no timestamps');
  await fs.writeFile(files[1],JSON.stringify(subtitles,null,2)+'\n',{flag:'wx'});
  receipt.status='audio_and_provider_timestamps_received';
  await fs.writeFile(files[2],JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify({status:receipt.status,audio:out,subtitles:files[1],receipt:files[2],audioBytes:audio.length}));
}

if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e=>{console.error(JSON.stringify({status:'failed',message:String(e.message).replace(/https?:\/\/\S+/g,'[url omitted]')}));process.exitCode=1;});
}
