"""Use exact provider original-word spans when adjacent dictionary phonemes merge."""
import sys,unittest,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'bin'))
from minimax_directing import provider_words
class AdjacentDictionarySpans(unittest.TestCase):
 def sample(self):
  return [{'text':'重新执行。','pronounce_text':'ㄔㄨㄥˊㄒㄧㄣˉㄓˊㄒㄧㄥˊ。','text_begin':0,'pronounce_text_begin':0,'timestamped_words':[
   dict(word='重新',word_begin=0,word_end=2,pronounce_word_begin=0,pronounce_word_end=8,time_begin=0,time_end=400),
   dict(word='执行',word_begin=2,word_end=4,pronounce_word_begin=8,pronounce_word_end=14,time_begin=400,time_end=800),
   dict(word='。',word_begin=4,word_end=5,pronounce_word_begin=14,pronounce_word_end=15,time_begin=800,time_end=900)]}]
 def test_adjacent_words_keep_exact_original_text_and_provider_times(self):
  words=provider_words(self.sample(),'重新执行。',keys=['重新','执行'])
  self.assertEqual([(w['text'],w['start'],w['end'])for w in words],[('重新',0,.4),('执行',.4,.8),('。',.8,.9)])
 def test_wrong_original_word_is_rejected(self):
  raw=self.sample();raw[0]['timestamped_words'][1]['word']='错词'
  with self.assertRaises(ValueError):provider_words(raw,'重新执行。',keys=['重新','执行'])
 def test_changed_authored_text_is_rejected(self):
  with self.assertRaises(ValueError):provider_words(self.sample(),'重新丢失执行。',keys=['重新','执行'])
 def test_missing_internal_english_space_preserves_authored_offsets(self):
  raw=[{'text':'Go.Next.','pronounce_text':'Go.Next.','timestamped_words':[
   dict(word='Go.',word_begin=0,word_end=3,pronounce_word_begin=0,pronounce_word_end=3,time_begin=0,time_end=300),
   dict(word='Next.',word_begin=3,word_end=8,pronounce_word_begin=3,pronounce_word_end=8,time_begin=400,time_end=800)]}]
  words=provider_words(raw,'Go. Next.')
  self.assertEqual([(w['text'],w['char_start'])for w in words],[('Go.',0),('Next.',4)])
  with self.assertRaises(ValueError):provider_words(raw,'Go. LOST Next.')
if __name__=='__main__':unittest.main()
