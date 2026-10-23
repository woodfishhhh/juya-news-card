"""Regression checks for production timing and complete-frame page fades."""
from pathlib import Path
import importlib.util
import unittest
import tempfile
import math
import wave
import numpy as np
from PIL import ImageDraw
from PIL import Image

root = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("juya_entry", root / "bin/render-juya-video.py")
entry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(entry)

class FadeRegression(unittest.TestCase):
    def test_card_and_popup_both_fade_through_white(self):
        manifest = {"fps": 30, "themes": [{"duration_seconds": 8, "section_id": "news"}],
                    "sections": [{"id": "news", "title": "News"}]}
        base = Image.new("RGB", (320, 180), (20, 40, 60))
        popup = Image.new("RGB", (200, 100), (100, 20, 40))
        full = entry.renderer.compose_frame(base, manifest, None, popup, "", 320, 180,
                                            320/1920, 1, 1, 100, False)
        half = entry.renderer.compose_frame(base, manifest, None, popup, "", 320, 180,
                                            320/1920, .5, 1, 100, False)
        for point in [(10, 100), (160, 80)]:
            expected = tuple(round((255 + value)/2) for value in full.getpixel(point))
            actual = half.getpixel(point)
            self.assertTrue(all(abs(a-b) <= 1 for a,b in zip(actual, expected)), (point, actual, expected))
        blank = entry.renderer.compose_frame(base, manifest, None, popup, "", 320, 180,
                                             320/1920, 0, 1, 100, False)
        self.assertEqual(blank.getextrema(), ((255, 255), (255, 255), (255, 255)))

class ProductionRegression(unittest.TestCase):
    def test_saved_playlist_is_not_shuffled_a_second_time(self):
        tracks=[{'name':'boring life','path':'first.mp3','opening':True,'resolved_index':0}]
        tracks += [{'name':name,'path':name+'.mp3','resolved_index':i} for i,name in enumerate(['B','C','D','E'],1)]
        for seed in [1,7,20261021]:
            self.assertEqual([t['name'] for t in entry.renderer.choose_music(tracks,seed)],[t['name'] for t in tracks])

    def test_single_line_caption_is_compact_and_preserves_every_glyph(self):
        from juya_production import caption_geometry
        for text in ['大家好，我是木鱼', '感谢你的收看，早点休息',
                     'Thanks for watching, and get some rest.']:
            actual=Image.new('RGBA',(1920,1080),'black')
            entry.renderer.draw_caption(ImageDraw.Draw(actual),text,1920,1080,1)
            font,plate,placements=caption_geometry(entry.renderer,ImageDraw.Draw(actual),text,1920,1080,1)
            self.assertEqual(len(placements),1)
            reference=Image.new('L',actual.size,0);d=ImageDraw.Draw(reference)
            for line,xy,_ in placements:d.text(xy,line,font=font,fill=255)
            a=np.asarray(actual)[:,:,:3];mask=np.asarray(reference)>240
            self.assertTrue(np.all(a[mask]>=240))
            self.assertLessEqual(plate[3]-plate[1],60)
            self.assertEqual(font.size,40)
            self.assertLessEqual(plate[3],1000)
        with self.assertRaises(entry.renderer.RenderError):
            caption_geometry(entry.renderer,ImageDraw.Draw(actual),'一行\n第二行',1920,1080,1)

    def test_popout_scales_up_and_background_gently_darkens(self):
        from juya_media import popup_envelope
        from juya_production import compose
        m={'fps':30};base=Image.new('RGB',(960,540),(200,200,200));popup=Image.new('RGB',(400,250),(245,20,20))
        areas=[]
        for t in [0,.10,.20,.40]:
            opacity,scale=popup_envelope(t,3)
            im=compose(entry.renderer,base,m,None,popup,'',960,540,.5,1,0,90,False,opacity,scale)
            rgb=np.asarray(im);areas.append(int(((rgb[:,:,0]>220)&(rgb[:,:,1]<70)).sum()))
            self.assertAlmostEqual(int(rgb[480,20,0]),round(200*(1-.18*opacity)),delta=1)
        self.assertEqual(areas[0],0);self.assertGreater(areas[2],areas[1]);self.assertGreater(areas[3],areas[1])
        self.assertEqual(popup_envelope(3,3)[0],0)

    def test_media_ranges_never_repeat_and_images_are_short(self):
        from juya_media import validate_sequence,schedule_media
        seq=schedule_media([{'path':'photo.png','kind':'image','seconds':20},{'path':'demo.mp4','kind':'video','source_in':0,'source_out':12,'seconds':12}],20)
        self.assertLessEqual(seq[0]['end_seconds']-seq[0]['start_seconds'],3)
        a={'path':'demo.mp4','kind':'video','start_seconds':5,'end_seconds':8,'source_in':0,'source_out':3}
        b={**a,'start_seconds':10,'end_seconds':13,'source_in':2,'source_out':5}
        with self.assertRaisesRegex(ValueError,'Repeated'):validate_sequence([a,b])
        b.update(source_in=3,source_out=6);validate_sequence([a,b])

    def test_finite_video_decoder_refuses_to_replay_at_eof(self):
        from juya_media import ClipReader
        with tempfile.TemporaryDirectory(prefix='juya-finite-clip-') as folder:
            path=Path(folder)/'source.mp4'
            entry.renderer.run(['ffmpeg','-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=30:duration=1','-c:v','libx264',str(path)])
            reader=ClipReader(path,{'source_in':.2,'source_out':.8,'frame_count':18},160,90,30)
            try:
                for _ in range(18):self.assertEqual(reader.next().size,(160,90))
                with self.assertRaisesRegex(RuntimeError,'replay'):reader.next()
            finally:reader.close()

    def test_twenty_five_fps_cut_has_all_thirty_fps_output_frames(self):
        from juya_media import ClipReader
        with tempfile.TemporaryDirectory(prefix='juya-25fps-cut-') as folder:
            path=Path(folder)/'source.mp4'
            entry.renderer.run(['ffmpeg','-y','-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=25:duration=2','-c:v','libx264',str(path)])
            reader=ClipReader(path,{'source_in':.5,'source_out':1.4,'frame_count':27},160,90,30)
            try:
                for _ in range(27):self.assertEqual(reader.next().size,(160,90))
                with self.assertRaisesRegex(RuntimeError,'replay'):reader.next()
            finally:reader.close()

    def test_phrase_subdivision_preserves_the_entire_script(self):
        from juya_captions import split_phrases
        for lang,text in [('zh','今天的具身智能晚报就到这里了，感谢你的收看，早点休息'),
                          ('en','A robot can use multiple different clips without replaying the same source interval, while the captions remain on one compact line.')]:
            phrases=split_phrases(text,lang)
            self.assertEqual(''.join(phrases),text)
        text='集成装配、训练采数、数字孪生与数据中心。'
        self.assertEqual(split_phrases(text,'zh'),[text])

    def test_continuous_cut_has_no_empty_gap_and_video_keeps_its_action(self):
        from juya_production import timeline_for
        from juya_media import schedule_media
        m={'opening_seconds':4.347,'theme_gap_seconds':0,'transition_mode':'cut',
           'themes':[{'duration_seconds':31.074},{'duration_seconds':27.138}]}
        total,timeline=timeline_for(m)
        self.assertEqual([k for s,e,k,i in timeline],['theme','theme'])
        self.assertEqual(timeline[0][1],timeline[1][0])
        self.assertGreaterEqual(timeline[0][0],4.347)
        self.assertLess(timeline[0][0]-4.347,1/30)
        edits=schedule_media([{'path':'demo.mp4','kind':'video','source_in':2,'source_out':14,'seconds':12},
                              {'path':'other.mp4','kind':'video','source_in':0,'source_out':10,'seconds':10},
                              {'path':'photo.png','kind':'image','seconds':9},{'path':'photo2.png','kind':'image','seconds':3}],31)
        self.assertAlmostEqual(edits[0]['source_out']-edits[0]['source_in'],12)
        self.assertLessEqual(edits[2]['end_seconds']-edits[2]['start_seconds'],3)
        self.assertEqual(edits[0]['start_seconds'],2.5)
        self.assertEqual(edits[-1]['end_seconds'],28.5)
        for a,b in zip(edits,edits[1:]):self.assertAlmostEqual(a['end_seconds'],b['start_seconds'])

    def test_media_shortage_cannot_fall_back_to_a_card(self):
        from juya_media import schedule_media,validate_sequence
        with self.assertRaisesRegex(ValueError,'more related media'):
            schedule_media([{'path':'photo.png','kind':'image','seconds':3}],40)
        with self.assertRaisesRegex(ValueError,'Uncovered'):
            validate_sequence([{'kind':'image','path':'a','start_seconds':2.5,'end_seconds':5.5},
                               {'kind':'image','path':'b','start_seconds':6,'end_seconds':8.5}],media_window=(2.5,8.5))

    def test_continuous_popout_remains_visible_at_each_media_cut(self):
        from juya_media import popup_envelope
        for t in [0,.05,.1,.3,2.99]:
            opacity,scale=popup_envelope(t,3,continuous=True,last=False)
            self.assertEqual(opacity,1);self.assertGreaterEqual(scale,.75)
        self.assertEqual(popup_envelope(2.98,3,continuous=True,last=True)[0],1)

    def test_page_turn_is_short_broadband_paper_rustle(self):
        from juya_production import make_page_turn
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'turn.wav';make_page_turn(path)
            with wave.open(str(path),'rb') as w:
                self.assertEqual(w.getnchannels(),2);self.assertEqual(w.getframerate(),48000)
                self.assertEqual(w.getnframes(),15360);a=np.frombuffer(w.readframes(w.getnframes()),dtype='<i2').reshape(-1,2)[:,0].astype(float)
            spectrum=np.abs(np.fft.rfft(a))
            self.assertGreater(np.count_nonzero(spectrum>spectrum.max()*.1),100)

    def test_provider_words_fold_dictionary_phonemes_and_map_missing_english_spaces(self):
        from minimax_directing import provider_words
        raw=[{'text':'处理。','text_begin':0,'timestamped_words':[
             {'word':'处理','word_begin':0,'word_end':2,'time_begin':0,'time_end':100},
             {'word':'处理','word_begin':0,'word_end':2,'time_begin':100,'time_end':200},
             {'word':'。','word_begin':2,'word_end':3,'time_begin':200,'time_end':240}]}]
        words=provider_words(raw,'处理。');self.assertEqual(len(words),2);self.assertEqual(words[0]['end'],.2)
        raw=[{'text':'Go.','text_begin':0,'timestamped_words':[{'word':'Go.','word_begin':0,'word_end':3,'time_begin':0,'time_end':200}]},
             {'text':'Next.','text_begin':3,'timestamped_words':[{'word':'Next.','word_begin':4,'word_end':9,'time_begin':220,'time_end':500}]}]
        words=provider_words(raw,'Go. Next.');self.assertEqual(words[1]['char_start'],4)
        with self.assertRaises(ValueError):provider_words(raw,'Go. LOST Next.')

    def test_both_navigation_bars_advance_monotonically(self):
        from juya_production import timeline_for, navigation
        m={'fps':30,'opening_seconds':5,'theme_gap_seconds':.5,'language':'en',
           'sections':[{'id':'one','title':'Industry'},{'id':'two','title':'Research'}],
           'themes':[{'title':'A','event_title':'A','section_id':'one','duration_seconds':7},
                     {'title':'B','event_title':'B','section_id':'one','duration_seconds':9},
                     {'title':'C','event_title':'C','section_id':'two','duration_seconds':6}]}
        _,timeline=timeline_for(m);positions=[]
        for start,end,kind,i in timeline:
            if kind!='theme':continue
            for moment in [start+.3,(start+end)/2,end-.3]:
                frame=Image.new('RGBA',(1920,1080),'white')
                navigation(entry.renderer,frame,m,i,moment,1920,1080,1)
                a=np.asarray(frame);top=np.where(np.all(a[53,:,:3]==entry.renderer.CORAL,axis=1))[0][-1]
                bottom=np.where(np.all(a[1079,:,:3]==entry.renderer.CORAL,axis=1))[0][-1]
                self.assertEqual(int(top),int(bottom));positions.append(int(top))
        self.assertEqual(positions,sorted(positions))

    def test_encoded_audio_is_silent_between_distinct_scheduled_voices(self):
        r=entry.renderer
        with tempfile.TemporaryDirectory(prefix='juya-audio-regression-') as folder:
            path=Path(folder)
            for i,hz in enumerate([330,660,990]):
                samples=(np.sin(np.arange(32000)/32000*2*math.pi*hz)*.15*32767).astype('<i2')
                with wave.open(str(path/f'{i}.wav'),'wb') as writer:
                    writer.setparams((1,2,32000,0,'NONE',''));writer.writeframes(samples.tobytes())
            r.run(['ffmpeg','-v','error','-y','-f','lavfi','-i','color=white:s=320x180:r=30:d=9','-an','-c:v','libx264',str(path/'video.mp4')])
            m={'language':'en','fps':30,'opening_narration':'0.wav','themes':[{'narration':'1.wav','card_seconds':1},{'narration':'2.wav','card_seconds':1}]}
            r.mix_audio(m,path,path/'video.mp4',path/'result.mp4',9,[(2,5,'theme',0),(5,9,'theme',1)],0,[])
            data=r.run(['ffmpeg','-v','error','-i',str(path/'result.mp4'),'-f','f32le','-ar','8000','-ac','1','pipe:1']).stdout
            audio=np.frombuffer(data,dtype='<f4')
            for start in [0,3,6]:
                cut=audio[round((start+.15)*8000):round((start+.6)*8000)]
                spectrum=np.abs(np.fft.rfft(cut));hz=np.argmax(spectrum)*8000/len(cut)
                self.assertAlmostEqual(hz,[330,660,990][start//3],delta=5)
                self.assertGreater(float(np.sqrt(np.mean(cut*cut))),.04)
            for start in [1,2,4,5,7,8]:
                cut=audio[round((start+.15)*8000):round((start+.6)*8000)]
                self.assertLess(float(np.sqrt(np.mean(cut*cut))),.0001)

if __name__ == "__main__":
    unittest.main()
