import sys,json,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bin'))
from juya_media import schedule_bound_media,validate_bindings
from juya_review import build_identity,write,read,digest,video_identity,record_review,check_review

class MediaBindings(unittest.TestCase):
    def setUp(self):
        self.cues=[{'text':'Robot performs a grasp.','start':0,'end':7.8},{'text':'The trial uses a new controller.','start':7.8,'end':15.6}]
        self.items=[{'kind':'video','path':'a.mp4','source_in':0,'source_out':8,'seconds':8,'binding':{'sentence':0,'text':self.cues[0]['text']}},
                    {'kind':'video','path':'a.mp4','source_in':10,'source_out':18,'seconds':8,'binding':{'sentence':1,'text':self.cues[1]['text']}}]
    def test_actual_audio_anchors_and_finite_intervals(self):
        rows=schedule_bound_media(self.items,self.cues,12)
        self.assertEqual([(r['start_seconds'],r['end_seconds']) for r in rows],[(2.5,6.0),(6.0,9.5)])
        self.assertEqual(rows[1]['source_out'],13.5)
        validate_bindings(rows,self.cues,12)
        rows[0]['end_seconds']+=1/30
        with self.assertRaises(ValueError):validate_bindings(rows,self.cues,12)
    def test_script_change_and_shortage_stop(self):
        self.items[0]['binding']['text']='Changed'
        with self.assertRaisesRegex(ValueError,'text changed'):schedule_bound_media(self.items,self.cues,12)
        self.items[0]['binding']['text']=self.cues[0]['text'];self.items[0]['seconds']=1
        with self.assertRaisesRegex(ValueError,'more related media'):schedule_bound_media(self.items,self.cues,12)
    def test_ordinary_image_stays_short_even_in_long_sentence(self):
        self.items[0].update(kind='image',path='a.png',seconds=10)
        with self.assertRaisesRegex(ValueError,'more related media'):schedule_bound_media(self.items,self.cues,12)

class VersionBinding(unittest.TestCase):
    def test_audio_asset_caption_video_and_evidence_mutations_invalidate(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);m=root/'manifest.zh.json';video=root/'sample.mp4'
            for f in ['audio.wav','photo.png','content.json']:(root/f).write_bytes(b'original')
            write(m,{'language':'zh','themes':[{'narration':'audio.wav','media_sequence':[{'path':'photo.png'}],'captions':[{'text':'hello'}]}]})
            video.write_bytes(b'video');before=build_identity(m)
            write(video.with_suffix('.manifest.json'),{'language':'zh','sha256':digest(video),'productionBinding':{'manifest':m.name,'inputs':before}})
            identity=video_identity(video)
            write(root/'verification/video.zh.json',{'status':'technical_checks_passed','productionIdentity':identity})
            evidence=root/'visual.txt';evidence.write_text('Actual inspection notes')
            record_review(video,'visual','approved','Inspected frames and timing',[evidence],'test reviewer')
            check_review(video,'visual')
            for name in ['audio.wav','photo.png','content.json','sample.mp4']:
                p=root/name;old=p.read_bytes();p.write_bytes(b'changed')
                with self.assertRaises(ValueError):check_review(video,'visual')
                p.write_bytes(old)
            old=m.read_bytes();value=read(m);value['themes'][0]['captions'][0]['text']='edited';write(m,value)
            with self.assertRaises(ValueError):check_review(video,'visual')
            m.write_bytes(old);evidence.write_text('changed notes')
            with self.assertRaisesRegex(ValueError,'evidence changed'):check_review(video,'visual')
    def test_missing_technical_is_not_an_approval(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/'legacy.mp4';p.write_bytes(b'legacy');write(p.with_suffix('.manifest.json'),{'language':'zh'})
            with self.assertRaisesRegex(ValueError,'historical'):video_identity(p)
    def test_cover_review_expires_when_design_or_pixels_change(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);spec=root/'cover.json';image=root/'cover.png';target=root/'cover.zh.provenance.json'
            spec.write_bytes(b'authored design');image.write_bytes(b'image bytes')
            write(target,{'kind':'independent-cover','language':'zh','issueContentSha256':'content-v1',
                'dependencies':[{'file':spec.name,'sha256':digest(spec)}],'outputs':[{'file':image.name,'sha256':digest(image)}]})
            evidence=root/'inspection.txt';evidence.write_text('Inspected the layout')
            record_review(target,'visual','approved','Layout checked',[evidence],'test reviewer');check_review(target,'visual')
            for path in [spec,image]:
                old=path.read_bytes();path.write_bytes(b'changed')
                with self.assertRaises(ValueError):check_review(target,'visual')
                path.write_bytes(old)

if __name__=='__main__':unittest.main()
