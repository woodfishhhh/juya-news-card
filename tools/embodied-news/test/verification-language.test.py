import importlib.util,json,tempfile,unittest
from pathlib import Path
path=Path(__file__).resolve().parents[1]/'bin/verify-juya-audio.py'
spec=importlib.util.spec_from_file_location('verify_audio_language',path)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
class VideoLanguage(unittest.TestCase):
    def test_render_receipt_controls_language_after_custom_output_name(self):
        with tempfile.TemporaryDirectory() as td:
            video=Path(td)/'my-custom-cut.mp4'
            video.with_suffix('.manifest.json').write_text(json.dumps({'language':'zh'}))
            self.assertEqual(module.video_language(video),'zh')
    def test_legacy_suffix_and_unknown_language(self):
        with tempfile.TemporaryDirectory() as td:
            self.assertEqual(module.video_language(Path(td)/'issue-en.mp4'),'en')
            with self.assertRaisesRegex(ValueError,'language requires'):
                module.video_language(Path(td)/'custom.mp4')
