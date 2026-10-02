import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOL_DIR=Path(__file__).resolve().parents[1]
DEMO=TOOL_DIR/'demo'
RENDERER=TOOL_DIR/'render_evening.py'
SPEC=importlib.util.spec_from_file_location('render_evening',RENDERER)
renderer=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(renderer)

def command(args, ok=True):
    p=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    if ok and p.returncode:
        raise AssertionError(f"command failed: {args}\n{p.stdout}\n{p.stderr}")
    if not ok and p.returncode==0:
        raise AssertionError(f"command unexpectedly passed: {args}\n{p.stdout}")
    return p

class RendererIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        command([sys.executable,str(DEMO/'make_demo.py')])
        cls.tmp=tempfile.TemporaryDirectory(prefix='juya-render-test-')
        cls.out=Path(cls.tmp.name)
        cls.outputs={}
        for lang in ('zh','en'):
            manifest=DEMO/f'manifest.{lang}.json'
            name=f'integration-{lang}'
            command([sys.executable,str(RENDERER),str(manifest),'--output-dir',str(cls.out),
                     '--name',name,'--width','320','--height','180','--fps','30','--seed','17'])
            cls.outputs[lang]=cls.out/f'{name}.mp4'
        cls.zh_meta=json.loads((cls.out/'integration-zh.manifest.json').read_text())
    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def frame(self,lang,sec):
        p=self.out/f'{lang}-{sec}.png'
        command(['ffmpeg','-y','-hide_banner','-loglevel','error','-ss',str(sec),'-i',str(self.outputs[lang]),'-frames:v','1',str(p)])
        from PIL import Image
        return Image.open(p).convert('RGB')

    def test_mp4_streams_and_decode(self):
        for lang,path in self.outputs.items():
            probe=json.loads(command(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(path)]).stdout)
            video=next(s for s in probe['streams'] if s['codec_type']=='video')
            audio=next(s for s in probe['streams'] if s['codec_type']=='audio')
            self.assertEqual((video['width'],video['height']),(320,180))
            self.assertEqual(video['r_frame_rate'],'30/1')
            self.assertGreater(int(audio['sample_rate']),0)
            self.assertAlmostEqual(float(probe['format']['duration']),21.5,delta=.03)
            command(['ffmpeg','-v','error','-i',str(path),'-f','null','-'])

    def test_popup_starts_after_five_seconds_and_gap_is_half_second(self):
        before=self.frame('zh',9.9).getpixel((160,50))
        after=self.frame('zh',10.1).getpixel((160,50))
        self.assertGreater(min(before),225)   # white source card; popup not visible yet
        self.assertGreater(after[2],after[0]*1.5)  # blue synthetic popup has begun
        gap=self.frame('zh',13.25).getpixel((10,10))
        self.assertGreater(min(gap),245)  # exact white gap between the two 8s themes
        second_card=self.frame('zh',14.0).getpixel((160,50))
        second_popup=self.frame('zh',18.6).getpixel((160,50))
        self.assertGreater(min(second_card),225)
        self.assertGreater(second_popup[0],second_popup[2]*1.7)  # orange popup for theme 2
        gap_row=next(x for x in self.zh_meta['timeline'] if x['kind']=='gap')
        self.assertAlmostEqual(gap_row['end_seconds']-gap_row['start_seconds'],.5,places=3)

    def test_png_popup_works_when_first_theme_uses_no_video_reader(self):
        # Exercise a PNG as the first popup, before any MediaStream could initialize sizes.
        source=json.loads((DEMO/'manifest.zh.json').read_text())
        source['themes'][0].pop('media_video',None); source['themes'][0]['media']='assets/media-robot.png'
        manifest=DEMO/f'.png-first-test-{os.getpid()}.json'; manifest.write_text(json.dumps(source),encoding='utf-8')
        try:
            path=self.out/'png-first.mp4'
            command([sys.executable,str(RENDERER),str(manifest),'--output-dir',str(self.out),
                     '--name','png-first','--width','320','--height','180','--fps','30'])
            meta=json.loads((self.out/'png-first.manifest.json').read_text())
            self.assertEqual(meta['language'],'zh')
            self.assertTrue(path.is_file())
            sample=self.frame_from(path,10.1)
            px=sample.getpixel((160,50))
            self.assertGreater(px[2],px[0]*1.5)
        finally:
            manifest.unlink(missing_ok=True)

    def frame_from(self,path,sec):
        p=self.out/f'{path.stem}-{sec}.png'
        command(['ffmpeg','-y','-hide_banner','-loglevel','error','-ss',str(sec),'-i',str(path),'-frames:v','1',str(p)])
        from PIL import Image
        return Image.open(p).convert('RGB')

    def test_dynamic_navigation_tracks_current_theme_and_section(self):
        a=self.frame('zh',9.5); b=self.frame('zh',14.0)
        # section strip: selected section changes from research to open source
        self.assertGreater(a.getpixel((160,5))[0]-a.getpixel((160,5))[2],0)
        self.assertGreater(b.getpixel((260,5))[0]-b.getpixel((260,5))[2],0)
        # event underline changes from the first slot to the second slot
        a0=a.getpixel((45,178)); a1=a.getpixel((260,178))
        b0=b.getpixel((45,178)); b1=b.getpixel((260,178))
        self.assertGreater(a0[0],a0[1]*1.3)
        self.assertGreater(b1[0],b1[1]*1.3)
        self.assertLess(a1[0]-a1[1],45)
        self.assertLess(b0[0]-b0[1],45)
        # Section bar fills according to cumulative progress within the selected section.
        active_line=a.getpixel((160,8)); early_line=b.getpixel((230,8))
        self.assertGreater(active_line[0],active_line[1]*1.3)
        self.assertLess(early_line[0]-early_line[1],45)

    def test_narration_is_really_1_3x_and_caption_sentence_stays_complete(self):
        # Source tones are 2.6 seconds; atempo=1.3 makes each theme voice end at about 2.0s.
        audio_log=command(['ffmpeg','-hide_banner','-i',str(self.outputs['zh']),'-ss','10','-t','3',
                           '-af','silencedetect=noise=-40dB:d=0.10','-f','null','-']).stderr
        starts=[float(x.split('silence_start:')[1].split()[0]) for x in audio_log.splitlines() if 'silence_start:' in x]
        self.assertTrue(any(1.85<=s<=2.15 for s in starts),audio_log)
        theme=json.loads((DEMO/'manifest.zh.json').read_text())['themes'][0]
        self.assertEqual(renderer.caption_for(theme,.5,1.3),theme['captions'][0]['text'])
        self.assertEqual(renderer.caption_for(theme,1.1,1.3),theme['captions'][1]['text'])
        sentence='这是一句完整字幕，必须以一行或两行显示，不能因为长度而被硬截断。'
        lines,_=renderer.fit_lines(sentence,42,1650,2,16)
        self.assertEqual(''.join(lines),sentence)
        self.assertLessEqual(len(lines),2)
        self.assertEqual(self.zh_meta['narration_speed'],1.3)
        self.assertEqual(self.zh_meta['host_line'],'大家好，我是小鱼是木鱼，以上是今天具身智能动态')

    def test_license_gate_and_no_music_default(self):
        self.assertEqual(self.zh_meta['music'],'none; no BGM was supplied')
        manifest=DEMO/'manifest.zh.json'
        p=command([sys.executable,str(RENDERER),str(manifest),'--output-dir',str(self.out/'blocked'),
                   '--publication-ready'],ok=False)
        self.assertIn('publication-ready blocked',p.stderr)
        tracks=[{'name':'theme-c','path':'c'},{'name':'boring life','path':'first'},
                {'name':'theme-a','path':'a'},{'name':'theme-b','path':'b'}]
        first=renderer.choose_music(tracks,2026)
        second=renderer.choose_music(tracks,2026)
        self.assertEqual([x['name'] for x in first],[x['name'] for x in second])
        self.assertEqual(first[0]['name'],'boring life')
        self.assertEqual({x['name'] for x in first},{x['name'] for x in tracks})
        # Every seed preserves the pinned opening track; remaining entries are seeded.
        self.assertEqual(renderer.choose_music(tracks,7)[0]['name'],'boring life')
        self.assertNotEqual([x['name'] for x in renderer.choose_music(tracks,17)][1:],
                            [x['name'] for x in renderer.choose_music(tracks,18)][1:])
        self.assertTrue(renderer.local_card_request_allowed('file:///tmp/card.html'))
        self.assertTrue(renderer.local_card_request_allowed((DEMO/'card-local.html').as_uri(),DEMO))
        self.assertFalse(renderer.local_card_request_allowed('file:///tmp/outside-card.html',DEMO))
        self.assertTrue(renderer.local_card_request_allowed('data:text/plain,local'))
        self.assertTrue(renderer.local_card_request_allowed('blob:file:///tmp/id'))
        self.assertFalse(renderer.local_card_request_allowed('https://example.invalid/card.css'))
        self.assertFalse(renderer.local_card_request_allowed('http://example.invalid/card.png'))

    def test_declared_license_without_evidence_is_not_publication_ready(self):
        source=json.loads((DEMO/'manifest.zh.json').read_text())
        for theme in source['themes']: theme['license']={'status':'licensed'}
        source['opening_license']={'status':'licensed'}
        temp=DEMO/f'.license-test-{os.getpid()}.json'; temp.write_text(json.dumps(source),encoding='utf-8')
        try:
            p=command([sys.executable,str(RENDERER),str(temp),'--output-dir',str(self.out/'license-check'),
                       '--publication-ready'],ok=False)
            self.assertIn('evidence missing',p.stderr)
            self.assertIn('independently verified',p.stderr)
        finally:
            temp.unlink(missing_ok=True)

    def test_language_metadata(self):
        en=json.loads((self.out/'integration-en.manifest.json').read_text())
        self.assertEqual(en['language'],'en')
        self.assertEqual(self.zh_meta['language'],'zh')
        self.assertEqual(en['music_order'],self.zh_meta['music_order'])
        self.assertEqual(len([x for x in self.zh_meta['timeline'] if x['kind']=='theme']),2)

    def test_supplied_seeded_bgm_is_actually_mixed_and_matches_across_languages(self):
        tracks=[
            {"id":"opening-bgm","name":"boring life demo.wav","path":"assets/boring life demo.wav","volume":0.25,"license":{"status":"unknown"}},
            {"id":"wind-chime","name":"wind chime demo.wav","path":"assets/wind chime demo.wav","volume":0.20,"license":{"status":"unknown"}},
            {"id":"soft-pulse","name":"soft pulse demo.wav","path":"assets/soft pulse demo.wav","volume":0.20,"license":{"status":"unknown"}}
        ]
        manifests=[]; metas=[]
        try:
            for lang in ('zh','en'):
                source=json.loads((DEMO/f'manifest.{lang}.json').read_text())
                source['music_tracks']=tracks; source['music_seed']=17
                path=DEMO/f'.music-test-{lang}-{os.getpid()}.json'; path.write_text(json.dumps(source,ensure_ascii=False),encoding='utf-8'); manifests.append(path)
                name=f'music-{lang}'
                command([sys.executable,str(RENDERER),str(path),'--output-dir',str(self.out),
                         '--name',name,'--width','320','--height','180','--fps','30','--seed','17'])
                metas.append(json.loads((self.out/f'{name}.manifest.json').read_text()))
            self.assertEqual(metas[0]['music_order'],metas[1]['music_order'])
            self.assertEqual(metas[0]['music_order'][0],'boring life demo.wav')
            self.assertEqual(set(metas[0]['music_order']),{t['name'] for t in tracks})
            self.assertEqual(metas[0]['music'],'enabled')
            # Topic one starts at second 5. Supplied local BGM makes its opening two seconds non-silent.
            log=command(['ffmpeg','-hide_banner','-ss','5','-i',str(self.out/'music-zh.mp4'),'-t','2',
                         '-af','silencedetect=noise=-50dB:d=0.10','-f','null','-']).stderr
            self.assertNotIn('silence_start:',log,log)
        finally:
            for p in manifests: p.unlink(missing_ok=True)

    def test_existing_fixed_output_is_not_silently_overwritten(self):
        name='collision-check'; target=self.out/f'{name}.mp4'; target.write_bytes(b'keep me')
        p=command([sys.executable,str(RENDERER),str(DEMO/'manifest.zh.json'),'--output-dir',str(self.out),
                   '--name',name,'--width','320','--height','180','--fps','30'],ok=False)
        self.assertIn('refusing to overwrite',p.stderr)
        self.assertEqual(target.read_bytes(),b'keep me')
        target.unlink()

    def test_overwrite_failure_preserves_previous_complete_pair(self):
        name='atomic-overwrite-check'; target=self.out/f'{name}.mp4'; status=self.out/f'{name}.status.json'
        target.write_bytes(b'previous valid output marker')
        status.write_text('{"status":"complete","sha256":"previous"}\n')
        bad_video=DEMO/f'.invalid-test-video-{os.getpid()}.mp4'; bad_video.write_text('not an encoded video')
        manifest=json.loads((DEMO/'manifest.zh.json').read_text())
        manifest['themes'][0]['media_video']=bad_video.name
        manifest_path=DEMO/f'.atomic-overwrite-test-{os.getpid()}.json'; manifest_path.write_text(json.dumps(manifest),encoding='utf-8')
        try:
            command([sys.executable,str(RENDERER),str(manifest_path),'--output-dir',str(self.out),
                     '--name',name,'--width','320','--height','180','--fps','30','--overwrite'],ok=False)
            self.assertEqual(target.read_bytes(),b'previous valid output marker')
            self.assertEqual(json.loads(status.read_text())['sha256'],'previous')
            self.assertEqual(list(self.out.glob(f'.{name}.*.staging.mp4')),[])
        finally:
            bad_video.unlink(missing_ok=True); manifest_path.unlink(missing_ok=True)
            target.unlink(missing_ok=True); status.unlink(missing_ok=True)

    def test_non_16_by_9_output_is_rejected(self):
        p=command([sys.executable,str(RENDERER),str(DEMO/'manifest.zh.json'),'--output-dir',str(self.out/'aspect'),
                   '--width','320','--height','200','--fps','30'],ok=False)
        self.assertIn('16:9',p.stderr)

    def test_local_html_card_is_captured_without_external_network(self):
        # Card HTML is supported as a fully local input; the renderer blocks every non-file/data URL.
        try:
            card=renderer.make_card({'card_html':'card-local.html'},DEMO,320,180,99)
        except renderer.RenderError as e:
            self.skipTest(f"local Chromium cannot launch in this sandbox: {e}")
        self.assertEqual(card.size,(320,180))
        r,g,b=card.getpixel((2,2))
        self.assertLess(r,35); self.assertLess(g,60); self.assertGreater(b,35)

if __name__=='__main__':
    unittest.main(verbosity=2)
