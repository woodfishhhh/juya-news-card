"""One-line semantic captions, with boundaries guided by decoded speech pauses.

Sentence start/end samples remain authoritative. Inner phrase boundaries are
silence-guided editorial cuts, not ASR word timestamps or forced alignment.
"""
import re
import unicodedata
import wave
from pathlib import Path
import numpy as np

CONNECTORS = ('以及', '用于', '利用', '通过', '支持', '覆盖', '负责', '生成', '连接',
              '提供', '重点', '可以', '约', '让', '把', '从', '将', '并', '在', '为')


def _legacy_split_phrases(text, language):
    # Keep all punctuation and whitespace in stored cues; display strips edges.
    clauses = re.findall(r'[^，,。.!?！？；;：:、]+[，,。.!?！？；;：:、]*\s*|[，,。.!?！？；;：:、]+\s*', text)
    result = []
    for clause in clauses:
        while True:
            if language == 'zh':
                if len(clause.strip()) <= 25:
                    break
                options = []
                for at in range(10, min(25, len(clause)-6)):
                    # Do not break a number, an English word or a measurement.
                    if re.match(r'[A-Za-z0-9]', clause[at-1]) and re.match(r'[A-Za-z0-9]', clause[at]):
                        continue
                    if clause[at] in '十百千万亿点年月日美元秒米度个台条比':
                        continue
                    if any(clause.startswith(word, at) for word in CONNECTORS):
                        options.append(at)
                cut = min(options, key=lambda n: abs(n-20)) if options else 22
            else:
                words = list(re.finditer(r'\S+\s*', clause))
                if len(words) <= 10 and len(clause.strip()) <= 78:
                    break
                possible = [m.start() for m in words[4:10]
                            if re.match(r'(and|while|with|for|from|to|using|across|before|after|so|that)\b', m.group(), re.I)]
                cut = min(possible, key=lambda n: abs(n-47)) if possible else words[min(7,len(words)-2)].end()
            result.append(clause[:cut])
            clause = clause[cut:]
        if clause:
            result.append(clause)
    assert ''.join(result) == text, (text, result)
    return result


def display_text(text):
    return text.strip().strip('，,。.!?！？；;：:、').strip()


def split_phrases(text, language, protected=()):
    """Prefer complete clauses and intact lists; punctuation is not a cut order."""
    def width(s):return sum(1 if unicodedata.east_asian_width(c) in 'WF' else .52 for c in display_text(s))
    def valid(i):
        if any(a<i<b for a,b in protected):return False
        if 0<i<len(text):
            if re.match(r'[A-Za-z0-9]',text[i-1]) and re.match(r'[A-Za-z0-9]',text[i]):return False
            if text[i] in '十百千万亿点年月日美元秒米度个台条比%％':return False
            if text[i] in '，,。.!?！？；;：:、':return False
        return True
    points=[0]+[i for i in range(1,len(text)) if valid(i)]+[len(text)]
    best={0:(0,[])}
    for end in points[1:]:
        choices=[]
        for start in points:
            if start>=end or start not in best:continue
            part=text[start:end];w=width(part)
            if w>38.2 or not display_text(part):continue
            penalty=0
            if end<len(text):
                prior=text[:end].rstrip()
                if prior and prior[-1] in '，,。.!?！？；;：:':penalty=0
                elif language=='en' and (text[end-1].isspace() or text[end].isspace()):penalty=1.5
                elif any(text.startswith(c,end) for c in CONNECTORS):penalty=1.8
                else:penalty=5
            cost=best[start][0]+3+((w-28)/24)**2+penalty+(5 if w<9 and len(text)>15 else 0)
            choices.append((cost,best[start][1]+[part]))
        if choices:best[end]=min(choices,key=lambda x:x[0])
    if len(text) not in best:raise ValueError('No semantic single-line segmentation fits: '+text)
    result=best[len(text)][1]
    assert ''.join(result)==text
    return result


def provider_captions(sentence_cues, words, language):
    output=[];proof=[]
    for index,cue in enumerate(sentence_cues):
        origin=cue['char_start'];end=cue['char_end']
        protected=[(w['char_start']-origin,w['char_end']-origin) for w in words if w['char_start']>=origin and w['char_end']<=end]
        parts=split_phrases(cue['text'],language,protected)
        cursor=origin
        for part in parts:
            stop=cursor+len(part)
            selected=[w for w in words if w['char_end']>cursor and w['char_start']<stop]
            if not selected:raise ValueError('Caption has no provider timestamps')
            a=min(w['start'] for w in selected);b=max(w['end'] for w in selected)
            output.append({'start':a,'end':b,'text':part,'sentence_index':index,
                           'char_start':cursor,'char_end':stop,'timing_method':'provider_word_timestamps_original_character_spans'})
            cursor=stop
        proof.append({'sentence':index,'phraseCount':len(parts),'sourceStart':cue['start'],'sourceEnd':cue['end']})
    # Hold each complete thought until the next one begins. Natural punctuation
    # pauses should not make the caption blink off between adjacent phrases.
    for a,b in zip(output,output[1:]):
        if b['start']<a['start']-1e-6:raise ValueError('Provider caption time moved backward')
        a['end']=b['start']
    return output,{'method':'provider millisecond word timestamps mapped to original characters; repeated dictionary phonemes folded; semantic display groups',
                   'wordLevelProviderAlignment':True,'sentences':proof}


def phrase_captions(path, sentence_cues, language):
    with wave.open(str(path), 'rb') as sound:
        rate = sound.getframerate()
        samples = np.frombuffer(sound.readframes(sound.getnframes()), dtype='<i2').astype(np.float32)/32768
    hop = max(1, round(rate*.01))
    size = len(samples)//hop
    rms = np.sqrt(np.mean(samples[:size*hop].reshape(size,hop)**2,axis=1)+1e-12)
    smooth = np.convolve(rms, np.ones(7)/7, mode='same')
    output, proof = [], []
    for index, cue in enumerate(sentence_cues):
        parts = split_phrases(cue['text'], language)
        start, end = float(cue['start']), float(cue['end'])
        weights = [max(1, len(re.findall(r'\w+', p)) if language!='zh' else len(p.strip())) for p in parts]
        cumulative, boundaries = 0, [start]
        cuts = []
        for i, weight in enumerate(weights[:-1]):
            cumulative += weight
            target = start+(end-start)*cumulative/sum(weights)
            # Locate an actual quiet interval near the semantic editorial cut.
            low = max(boundaries[-1]+.35, target-.48)
            high = min(end-.35*(len(parts)-i-1),target+.48)
            lo, hi = max(0,round(low/.01)), min(len(smooth)-1,round(high/.01))
            if hi <= lo:
                boundary = max(boundaries[-1]+.1,min(end-.1,target))
                energy = None
            else:
                times=np.arange(lo,hi+1)*.01
                level=smooth[lo:hi+1]
                cost=level/(float(np.quantile(level,.8))+1e-6)+.24*((times-target)/.48)**2
                at=int(np.argmin(cost));boundary=float(times[at]);energy=float(level[at])
            boundaries.append(boundary)
            cuts.append({'time':boundary,'semanticTarget':target,'windowRms':energy})
        boundaries.append(end)
        for i, text in enumerate(parts):
            output.append({'start':boundaries[i], 'end':boundaries[i+1], 'text':text,
                           'sentence_index':index, 'timing_method':'semantic_cut_snapped_to_audio_energy_minimum'})
        proof.append({'sentence':index,'sourceStart':start,'sourceEnd':end,'phraseCount':len(parts),'cuts':cuts})
    return output, {'method':'sentence PCM samples; semantic phrase subdivision snapped to 70ms RMS minima within 480ms',
                    'wordLevelForcedAlignment':False,'analysisHopSeconds':.01,'sentences':proof}
