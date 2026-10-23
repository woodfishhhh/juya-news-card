"""Official MiniMax controls, whole-paragraph cache, and provider word alignment."""
from __future__ import annotations
import hashlib, json, subprocess, wave
from pathlib import Path
import numpy as np

RATE=32000
PROJECT=Path(__file__).resolve().parents[1]

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def save(path,value):Path(path).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')

def make_payload(text,language):
    rules=json.loads((PROJECT/'config/tts-pronunciations.zh.json').read_text(encoding='utf-8'))['rules'] if language=='Chinese' else []
    rules=[r for r in rules if r.split('/',1)[0] in text]
    p={'model':'speech-2.8-turbo','text':text,'stream':False,'output_format':'hex',
       'voice_setting':{'voice_id':'Podcast_girl','speed':1.0,'vol':1,'pitch':0},
       'audio_setting':{'sample_rate':RATE,'bitrate':128000,'format':'mp3','channel':1},
       'language_boost':language,'text_normalization_mode':'quality',
       'subtitle_enable':True,'subtitle_type':'word'}
    if rules:p['pronunciation_dict']={'tone':rules}
    return p

BOPOMOFO=set('ㄅㄆㄇㄈㄉㄊㄋㄌㄍㄎㄏㄐㄑㄒㄓㄔㄕㄖㄗㄘㄙㄚㄛㄜㄝㄞㄟㄠㄡㄢㄣㄤㄥㄦㄧㄨㄩㄪㄫㄬㄭㄮㄯ')
TONES=set('ˉˊˇˋ˙')
CN_NUM=set('零〇一二三四五六七八九十百千万亿两点')
EN_NUM={'0':'zero','1':'one','2':'two','3':'three','4':'four','5':'five','6':'six','7':'seven','8':'eight','9':'nine','.':'point'}

def _dict_keys():
    try:
        rules=json.loads((PROJECT/'config/tts-pronunciations.zh.json').read_text(encoding='utf-8'))['rules']
    except Exception:
        return []
    return sorted((r.split('/',1)[0] for r in rules), key=len, reverse=True)

def _num_run(text,i):
    e=i
    while e<len(text) and (text[e].isdigit() or text[e] in ',.%'):e+=1
    return e

_ONES=('zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve',
       'thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen')
_TENS=('','','twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety')

def _en_three(x,hyphen):
    out=''
    if x>=100:
        out+=_ONES[x//100]+' hundred';x%=100
        if x:out+=' '
    if x>=20:
        word=_TENS[x//10]
        if x%10:word+=('-' if hyphen else ' ')+_ONES[x%10]
        out+=word
    elif x:out+=_ONES[x]
    return out

def _en_int(n,hyphen):
    if n==0:return 'zero'
    parts=[]
    for value,name in ((10**9,'billion'),(10**6,'million'),(10**3,'thousand')):
        if n>=value:
            parts.append(_en_three(n//value,hyphen)+' '+name);n%=value
    if n:parts.append(_en_three(n,hyphen))
    return ' '.join(parts)

_CN_D='零一二三四五六七八九'

def _cn_int(n):
    if n==0:return '零'
    units=('','十','百','千');groups=('','万','亿','万亿');out='';gi=0
    while n>0:
        group=n%10000;n//=10000
        if group:
            digits=[]
            x=group
            while x>0:digits.append(x%10);x//=10
            piece=''
            for idx in range(len(digits)-1,-1,-1):
                d=digits[idx]
                if d==0:
                    if piece and not piece.endswith('零'):piece+='零'
                else:piece+=_CN_D[d]+units[idx]
            out=piece.rstrip('零')+groups[gi]+out
        elif out and not out.startswith('零'):out='零'+out
        gi+=1
    return out

def _spellings(run):
    """Every spoken form the service may return for one numeric run."""
    body=run.rstrip('%.')
    out=[]
    if body and (body[0].isdigit() or (body[0]=='.' and len(body)>1)):
        intpart,_,frac=body.partition('.')
        digits=intpart.replace(',','')
        if digits.isdigit():
            value=int(digits) if digits else 0
            if frac:
                fracwords=' '.join(EN_NUM[c] for c in frac if c in EN_NUM)
                head=_en_int(value,True) if value else 'zero'
                out.append(head+' point '+fracwords)
                out.append(head.replace('-',' ')+' point '+fracwords)
                cnhead=_cn_int(value) if value else '零'
                out.append(cnhead+'点'+''.join(_CN_D[int(c)] for c in frac))
            else:
                out.append(_en_int(value,True));out.append(_en_int(value,False))
                cn=_cn_int(value)
                out.append(cn)
                # The service may read a leading 二 as 两, e.g. 229 as 两百二十九.
                if cn.startswith('二'):
                    out.append('两'+cn[1:])
        elif frac:
            out.append('point '+' '.join(EN_NUM[c] for c in frac if c in EN_NUM))
    seen=[];result=[]
    for item in out:
        if item and item not in seen:seen.append(item);result.append(item)
    return result

def _han(c):
    return '\u4e00' <= c <= '\u9fff' or '\u3400' <= c <= '\u4dbf'

def _align(text,pron,keys):
    """Monotonic map from spoken-text indices back to authored-text indices.

    The service rewrites the text it speaks: it drops spaces around Latin runs,
    substitutes configured words with bopomofo readings, normalizes digits into
    Chinese numerals and can insert spaces between single Latin letters. Word
    timestamps are indexed against that spoken text, so each spoken position is
    mapped back to the authored character it came from. Returns a list of length
    len(pron); entries are None where the spoken text has no authored character.
    """
    n,m=len(text),len(pron);INF=float('inf')
    best=[[INF]*(m+1) for _ in range(n+1)];back=[[None]*(m+1) for _ in range(n+1)]
    best[0][0]=0.0
    for i in range(n+1):
        row=best[i]
        for j in range(m+1):
            c=row[j]
            if c==INF:continue
            if i<n and j<m and text[i]==pron[j] and c<best[i+1][j+1]:
                best[i+1][j+1]=c;back[i+1][j+1]=(i,j,'match')
            if i<n and (text[i].isspace() or text[i]=='-') and c+.6<best[i+1][j]:
                best[i+1][j]=c+.6;back[i+1][j]=(i,j,'drop')
            if j<m and pron[j].isspace() and c+.6<best[i][j+1]:
                best[i][j+1]=c+.6;back[i][j+1]=(i,j,'insert')
            if i<n and j<m and pron[j] in BOPOMOFO:
                e=j
                while e<m and (pron[e] in BOPOMOFO or pron[e] in TONES):e+=1
                for k in keys:
                    if text.startswith(k,i):
                        cost=c+2+.05*(e-j)
                        if cost<best[i+len(k)][e]:
                            best[i+len(k)][e]=cost;back[i+len(k)][e]=(i,j,'dict',k,e)
                        break
            if i<n and (text[i].isdigit() or text[i]=='.'):
                e1=_num_run(text,i)
                if e1>i:
                    for reading in _spellings(text[i:e1]):
                        if pron.startswith(reading,j):
                            if c+2<best[e1][j+len(reading)]:
                                best[e1][j+len(reading)]=c+2;back[e1][j+len(reading)]=(i,j,'num',e1,j+len(reading))
            if i<n and j<m and text[i]!=pron[j] and not text[i].isalnum() and not pron[j].isalnum() and c+1<best[i+1][j+1]:
                best[i+1][j+1]=c+1;back[i+1][j+1]=(i,j,'sub')
            # English narration spells digits out, e.g. AW-0 becomes A W zero.
            if i<n and j<m and text[i] in EN_NUM:
                reading=EN_NUM[text[i]]
                if pron.startswith(reading,j) and not (j+len(reading)<m and pron[j+len(reading)].isalnum()):
                    if c+2<best[i+1][j+len(reading)]:
                        best[i+1][j+len(reading)]=c+2;back[i+1][j+len(reading)]=(i,j,'en',len(reading))
            # The speech engine can return a same-pronunciation character in the
            # spoken text, e.g. 帧 read back as 珍. Treat one Han character as a
            # substitute for another Han character only.
            if i<n and j<m and text[i]!=pron[j] and _han(text[i]) and _han(pron[j]) and c+1.5<best[i+1][j+1]:
                best[i+1][j+1]=c+1.5;back[i+1][j+1]=(i,j,'sub')
    if best[n][m]==INF:return None
    inv=[None]*m;i,j=n,m
    while (i,j)!=(0,0):
        step=back[i][j]
        if step is None:return None
        pi,pj,kind=step[0],step[1],step[2]
        if kind in ('match','sub'):
            inv[pj]=pi
        elif kind=='en':
            for t in range(step[3]):inv[pj+t]=pi
        elif kind=='dict':
            span=len(step[3]);end=step[4]
            for t in range(end-pj):inv[pj+t]=pi+min(t,span-1)
        elif kind=='num':
            end1,end2=step[3],step[4]
            for t in range(end2-pj):inv[pj+t]=pi+min(t,end1-pi-1)
        i,j=pi,pj
    return inv

def provider_words(raw,text,keys=None):
    """Fold provider word timings back onto original-character spans. Times are ms."""
    if keys is None:keys=_dict_keys()
    grouped={};search=0
    for seg in raw:
        segment_text=seg['text']
        origin=text.find(segment_text,search)
        if origin>=0 and not text[search:origin].strip():
            segment_positions=list(range(origin,origin+len(segment_text)))
            search=origin+len(segment_text)
        else:
            # Some English responses omit spaces even inside a returned segment.
            # Match every non-space character exactly and retain authored offsets.
            cursor=search;segment_positions=[]
            for char in segment_text:
                if char.isspace():
                    segment_positions.append(cursor if cursor<len(text) and text[cursor].isspace() else None)
                    while cursor<len(text) and text[cursor].isspace():cursor+=1
                    continue
                while cursor<len(text) and text[cursor].isspace():cursor+=1
                if cursor>=len(text) or text[cursor]!=char:
                    raise ValueError('Provider segment differs from original narration')
                segment_positions.append(cursor);cursor+=1
            search=cursor
        pron=seg.get('pronounce_text') or segment_text
        pbegin=int(seg.get('pronounce_text_begin',seg.get('text_begin',0)))
        words=seg.get('timestamped_words',[])
        if not words:raise ValueError('Provider segment has no word timestamps')
        if all('pronounce_word_begin' not in w and 'pronounce_word_end' not in w for w in words):
            # Older provider receipts contain exact original-text spans only.
            # Match them verbatim; repeated spans are phonemes of the same word.
            original_spans=None
            for base in (int(seg.get('text_begin',0)),0,segment_positions[0] if segment_positions else 0):
                candidate=[(int(w['word_begin'])-base,int(w['word_end'])-base) for w in words]
                if all(0<=a<b<=len(segment_text) and segment_text[a:b]==w['word'] for w,(a,b) in zip(words,candidate)):
                    original_spans=candidate;break
            if original_spans is None:raise ValueError('Original provider word spans do not match narration')
            covered=set()
            for w,(a,b) in zip(words,original_spans):
                covered.update(range(a,b));mapped=[q for q in segment_positions[a:b] if q is not None]
                if not mapped:continue
                lo,hi=min(mapped),max(mapped)+1
                start,end=float(w['time_begin'])/1000,float(w['time_end'])/1000
                if end<=start:raise ValueError('Invalid provider word time interval')
                row=grouped.setdefault((lo,hi),{'char_start':lo,'char_end':hi,'text':text[lo:hi],'start':start,'end':end})
                row['start']=min(row['start'],start);row['end']=max(row['end'],end)
            if any(i not in covered and not ch.isspace() for i,ch in enumerate(segment_text)):
                raise ValueError('Original provider word spans do not cover narration')
            continue
        cursor=pbegin;spans=[]
        for w in words:
            a=int(w['pronounce_word_begin']);b=int(w['pronounce_word_end'])
            if a!=cursor:raise ValueError('Provider word spans do not tile the spoken text: '+repr(w['pronounce_word']))
            cursor=b;spans.append((a,b,float(w['time_begin'])/1000,float(w['time_end'])/1000))
        if cursor-pbegin!=len(pron):raise ValueError('Provider word spans do not cover the spoken text')
        inv=_align(segment_text,pron,keys)
        if inv is None:
            # Adjacent dictionary words can form one uninterrupted phonetic run.
            # Recover only when every provider original-text span matches exactly;
            # never estimate timings or accept a fuzzy text match.
            original_spans = None
            for base in (int(seg.get('text_begin', 0)), 0):
                candidate = [(int(w['word_begin'])-base, int(w['word_end'])-base) for w in words]
                if all(0 <= a < b <= len(segment_text) and segment_text[a:b] == w['word']
                       for w, (a, b) in zip(words, candidate)):
                    original_spans = candidate
                    break
            if original_spans is None:
                raise ValueError('Cannot align spoken text back to the original narration: '+repr(segment_text[:60]))
            for w, (a, b) in zip(words, original_spans):
                mapped=[q for q in segment_positions[a:b] if q is not None]
                if not mapped:continue
                lo, hi = min(mapped), max(mapped)+1
                row = grouped.setdefault((lo, hi), {'char_start': lo, 'char_end': hi,
                    'text': text[lo:hi], 'start': float(w['time_begin'])/1000,
                    'end': float(w['time_end'])/1000})
                row['start'] = min(row['start'], float(w['time_begin'])/1000)
                row['end'] = max(row['end'], float(w['time_end'])/1000)
            continue
        for a,b,start,end in spans:
            lo=None;hi=None
            for q in range(a-pbegin,b-pbegin):
                if not 0<=q<len(inv):continue
                target=inv[q]
                if target is None:continue
                target=segment_positions[target]
                if target is None:continue
                lo=target if lo is None else min(lo,target);hi=target+1 if hi is None else max(hi,target+1)
            if lo is None or hi is None or hi<=lo:continue
            row=grouped.setdefault((lo,hi),{'char_start':lo,'char_end':hi,'text':text[lo:hi],
                                            'start':start,'end':end})
            row['start']=min(row['start'],start);row['end']=max(row['end'],end)
    result=sorted(grouped.values(),key=lambda x:(x['char_start'],x['char_end']))
    covered=set()
    for w in result:
        if w['end']<w['start']:raise ValueError('Reversed provider timestamp')
        covered.update(range(w['char_start'],w['char_end']))
    missing=[i for i,c in enumerate(text) if not c.isspace() and c!='-' and i not in covered]
    if missing:raise ValueError('Provider timestamps omit original characters: '+repr(missing[:12]))
    return result

def paragraph(root,name,sentences,language,node):
    text=('' if language=='Chinese' else ' ').join(sentences)
    payload=make_payload(text,language)
    key=hashlib.sha256(json.dumps({'region':'cn','payload':payload},sort_keys=True,ensure_ascii=False).encode()).hexdigest()
    directory=root/'audio/directed-cache';directory.mkdir(parents=True,exist_ok=True)
    base=directory/key;mp3=base.with_suffix('.mp3');request=base.with_suffix('.request.json')
    receipt=base.with_suffix('.receipt.json');subtitles=base.with_suffix('.subtitles.json')
    if not mp3.exists():
        if receipt.exists() or subtitles.exists():raise RuntimeError('Incomplete cached response: inspect before retry')
        save(request,payload)
        cmd=[str(node),str(PROJECT/'.codex/skills/minimax-tts-directing/scripts/synthesize.mjs'),
             '--payload',str(request),'--out',str(mp3),'--region','cn']
        run=subprocess.run(cmd,capture_output=True,timeout=300)
        if run.returncode:raise RuntimeError(run.stderr.decode('utf-8',errors='replace')[-900:])
    if not receipt.exists() or not subtitles.exists():raise RuntimeError('Paid audio is cached but timestamps missing; do not resynthesize')
    proof=json.loads(receipt.read_text(encoding='utf-8'))
    if sha(mp3)!=proof['audioSha256']:raise RuntimeError('Directed audio cache hash mismatch')
    if json.loads(request.read_text(encoding='utf-8'))!=payload:raise RuntimeError('Directed request cache mismatch')
    data=subprocess.check_output(['ffmpeg','-v','error','-i',str(mp3),'-ac','1','-ar',str(RATE),'-f','s16le','pipe:1'])
    samples=np.frombuffer(data,dtype='<i2')
    if not len(samples):raise RuntimeError('Empty decoded paragraph')
    # Conservative 10 ms RMS gate, with consonant/breath guards. No internal
    # sentence shortening or invented punctuation timing.
    hop=320;n=len(samples)//hop
    rms=np.sqrt(np.mean((samples[:n*hop].astype(np.float64)/32768).reshape(n,hop)**2,axis=1))
    active=np.flatnonzero(rms>max(.0008,float(rms.max())*.012))
    if not len(active):raise RuntimeError('No audible speech in decoded paragraph')
    first=max(0,int(active[0]*hop)-round(.035*RATE))
    last=min(len(samples),int((active[-1]+1)*hop)+round(.045*RATE))
    trim=first/RATE;duration=(last-first)/RATE
    words=provider_words(json.loads(subtitles.read_text(encoding='utf-8')),text)
    for w in words:
        w['start']=max(0,min(duration,w['start']-trim))
        w['end']=max(w['start'],min(duration,w['end']-trim))
    cues=[];cursor=0
    for sentence in sentences:
        matching=[w for w in words if w['char_end']>cursor and w['char_start']<cursor+len(sentence)]
        cues.append({'start':min(w['start'] for w in matching),'end':max(w['end'] for w in matching),
                     'text':sentence,'char_start':cursor,'char_end':cursor+len(sentence)})
        cursor+=len(sentence)+(0 if language=='Chinese' else 1)
    target=root/'audio'/f'{name}.wav'
    with wave.open(str(target),'wb') as writer:
        writer.setparams((1,2,RATE,0,'NONE',''));writer.writeframes(samples[first:last].tobytes())
    timeline={'sampleRate':RATE,'samples':last-first,'sourceSpeed':1.0,'renderSpeed':1.3,
              'cues':cues,'words':words,'sha256':sha(target),'providerTimingUnit':'milliseconds',
              'method':'whole-paragraph synthesis; original-character provider word timestamps; silence-only edge trim',
              'trimHeadSamples':first,'trimTailSamples':len(samples)-last,
              'originalDecodedSamples':len(samples),'requestSha256':sha(request),
              'sources':[{'source':str(mp3.relative_to(root)).replace('\\','/'),'audioSha256':sha(mp3),
                          'receipt':str(receipt.relative_to(root)).replace('\\','/'),'cacheKey':key,
                          'providerSubtitles':str(subtitles.relative_to(root)).replace('\\','/'),'text':text}]}
    save(target.with_suffix('.timeline.json'),timeline)
    print(json.dumps({'group':name,'seconds':duration,'sentences':len(cues),'dictionaryRules':len(payload.get('pronunciation_dict',{}).get('tone',[]))},ensure_ascii=False),flush=True)
    return str(target.relative_to(root)).replace('\\','/'),cues,duration,words
