"""Check current video and independently designed cover reviews before upload."""
import argparse,json
from pathlib import Path
from juya_review import review_identity,current_technical,check_review
def check(video,cover):
    identity=review_identity(video);c=review_identity(cover)
    if identity['kind']!='video' or c['kind']!='cover' or c['language']!=identity['language']:raise ValueError('Video/cover language or type mismatch')
    if not identity.get('issueContentSha256') or c['issueContentSha256']!=identity['issueContentSha256']:raise ValueError('Cover and video belong to different content versions')
    current_technical(video,identity)
    for stage in ['visual','acceptance']:check_review(video,stage)
    check_review(cover,'visual')
    return {'status':'version_reviews_current','video':identity,'cover':c,'publishingAuthorized':False}
if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('video',type=Path);ap.add_argument('cover',type=Path);a=ap.parse_args()
    print(json.dumps(check(a.video,a.cover)))
