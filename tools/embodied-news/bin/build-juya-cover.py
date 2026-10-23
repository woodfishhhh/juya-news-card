"""Design independent Juya covers, with reflowed landscape/portrait layouts."""
import argparse,json,os
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont,ImageOps
from juya_review import digest,local,object_hash,write

PAPER='#f5f0e6';INK='#292a2d';CORAL='#e86249'
def font(size):
    candidates=[Path(os.environ.get('WINDIR','C:/Windows'))/'Fonts/msyhbd.ttc',Path('/mnt/c/Windows/Fonts/msyhbd.ttc'),Path('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')]
    for p in candidates:
        if p.is_file():return ImageFont.truetype(str(p),size)
    raise RuntimeError('Cover font unavailable')
def lines(text,draw,f,width):
    # English wraps at words; CJK can wrap by glyph. Explicit newlines are preserved.
    result=[]
    for paragraph in text.split('\n'):
        words=paragraph.split(' ') if ' ' in paragraph else list(paragraph);joiner=' ' if ' ' in paragraph else ''
        row=''
        for word in words:
            candidate=row+joiner+word if row else word
            if draw.textlength(candidate,font=f)>width and row:result.append(row);row=word
            else:row=candidate
        if row:result.append(row)
    return result
def fitted(draw,text,box,maxsize,minsize=32):
    x,y,w,h=box
    for size in range(maxsize,minsize-1,-2):
        f=font(size);rows=lines(text,draw,f,w);step=round(size*1.35)
        if len(rows)*step<=h and all(draw.textlength(r,font=f)<=w for r in rows):
            for i,row in enumerate(rows):draw.text((x,y+i*step),row,font=f,fill=INK,anchor='lt')
            return {'fontSize':size,'lines':rows,'box':box}
    raise ValueError('Cover text does not fit; shorten the authored headline')
def compose(asset,design,language,size,date):
    w,h=size;portrait=h>w;im=Image.new('RGB',size,PAPER);d=ImageDraw.Draw(im)
    pad=70 if portrait else 90
    d.rounded_rectangle((pad,pad,pad+9,pad+48),radius=4,fill=CORAL)
    brand='具身智能日报' if language=='zh' else 'EMBODIED AI DAILY'
    d.text((pad+27,pad+3),brand,font=font(36 if portrait else 34),fill=INK,anchor='lt')
    d.text((w-pad,pad+8),date,font=font(23),fill='#716b63',anchor='rt')
    if portrait:
        text_box=(pad,165,w-pad*2,385);image_box=(pad,590,w-pad,h-125);sub_box=(pad,505,w-pad*2,65)
    else:
        text_box=(pad,235,795,470);image_box=(980,190,w-pad,915);sub_box=(pad,750,800,100)
    geometry=fitted(d,design['headline'],text_box,100 if not portrait else 88)
    subtitle=design.get('subtitle','')
    if subtitle:fitted(d,subtitle,sub_box,37,28)
    x0,y0,x1,y1=image_box
    # Contain preserves the robot's complete shape; no crop that removes hands/feet.
    panel=Image.new('RGB',(x1-x0,y1-y0),'#e6dfd2')
    photo=ImageOps.contain(asset.convert('RGB'),panel.size)
    panel.paste(photo,((panel.width-photo.width)//2,(panel.height-photo.height)//2))
    im.paste(panel,(x0,y0));d=ImageDraw.Draw(im)
    d.line((pad,h-74,w-pad,h-74),fill=INK,width=2)
    footer='机器人 · 技术 · 真实应用' if language=='zh' else 'ROBOTICS / RESEARCH / REAL-WORLD USE'
    d.text((pad,h-49),footer,font=font(22),fill='#716b63',anchor='lt')
    d.text((w-pad,h-49),'MUYU',font=font(22),fill=CORAL,anchor='rt')
    return im,geometry
def build(root,locale):
    root=root.resolve();content=json.loads((root/'content.json').read_text(encoding='utf-8'));spec=json.loads((root/'cover.json').read_text(encoding='utf-8'))
    design=spec['versions'][locale];theme=next((t for t in content['themes'] if t['id']==spec['themeId']),None)
    if not theme:raise ValueError('Cover theme must belong to this issue')
    if not design.get('headline','').strip() or not spec.get('sourceUrl') or not spec.get('rightsNote'):
        raise ValueError('Headline, actual asset source and rights note required')
    image=local(root,spec['image']);deps=[root/'content.json',root/'cover.json',image]
    dependency_rows=[{'file':p.relative_to(root).as_posix(),'sha256':digest(p)} for p in deps]
    revision=object_hash({'deps':dependency_rows,'locale':locale,'renderer':digest(Path(__file__))})[:16]
    out=root/'covers'/revision;out.mkdir(parents=True,exist_ok=True);outputs=[]
    with Image.open(image) as asset:
        for name,size in [('landscape',(1920,1080)),('portrait',(1080,1440))]:
            im,layout=compose(asset,design,locale,size,spec['dateLabel'])
            target=out/f'{locale}-{name}.png';im.save(target)
            outputs.append({'file':target.relative_to(root).as_posix(),'sha256':digest(target),'dimensions':list(size),'textLayout':layout})
    provenance={'schemaVersion':1,'kind':'independent-cover','language':locale,'issueId':content['issueId'],
                'themeId':spec['themeId'],'sourceUrl':spec['sourceUrl'],'rightsNote':spec['rightsNote'],
                'issueContentSha256':digest(root/'content.json'),'dependencies':dependency_rows,'outputs':outputs,
                'designCodeSha256':digest(Path(__file__)),'visualReview':'pending','userAcceptance':'pending','derivedFromVideoFrame':False}
    path=root/f'cover.{locale}.provenance.json';write(path,provenance);return path
if __name__=='__main__':
    ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('directory',type=Path);ap.add_argument('--locale',choices=['zh','en','all'],default='all');a=ap.parse_args()
    for lang in (['zh','en'] if a.locale=='all' else [a.locale]):print(build(a.directory,lang))
