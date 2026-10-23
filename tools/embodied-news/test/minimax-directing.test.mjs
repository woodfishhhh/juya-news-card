import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePayload} from '../.codex/skills/minimax-tts-directing/scripts/synthesize.mjs';

const request=()=>({model:'speech-2.8-turbo',text:'处理数据后，继续执行任务。',stream:false,output_format:'hex',
  voice_setting:{voice_id:'Podcast_girl',speed:1,vol:1,pitch:0},audio_setting:{format:'mp3'},
  pronunciation_dict:{tone:['处理/(chu3)(li3)']},text_normalization_mode:'quality',subtitle_enable:true,subtitle_type:'word'});
test('accepts official pronunciation object and word subtitles without loading SDK',()=>assert.equal(validatePayload(request()).subtitle_type,'word'));
test('rejects old CLI pronunciation array',()=>assert.throws(()=>validatePayload({...request(),pronunciation_dict:[{text:'处理',tone:'chu3li3'}]}),/must be/));
test('official pause is internal, bounded and not chained',()=>{
  assert.equal(validatePayload({...request(),text:'大家好。<#0.15#>欢迎收看。'}).text.includes('<#0.15#>'),true);
  for(const text of ['<#0.15#>欢迎','你好<#0.15#>','你好<#0.1#><#0.2#>欢迎','你好<#0.001#>欢迎','你好<break time="1s"/>欢迎'])
    assert.throws(()=>validatePayload({...request(),text}));
});
test('does not silently enable undocumented model emotion or streaming',()=>{
  assert.throws(()=>validatePayload({...request(),voice_setting:{...request().voice_setting,emotion:'whisper'}}),/2.6/);
  assert.throws(()=>validatePayload({...request(),stream:true}),/non-streaming/);
});
