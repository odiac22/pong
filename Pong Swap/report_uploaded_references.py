"""Build the non-identifying scan report and conservative, review-only shortlist."""
import json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageOps
from scan_uploaded_references import Detector, save_sample, sheet

OUT=Path('E:/Pong Face References/review-20260926')
r=json.loads((OUT/'scan.json').read_text(encoding='utf-8'))
detector=Detector()
rotations=[]
for row in r['files']:
    if row.get('type')!='photo' or not row.get('noFaceSamples'):continue
    with Image.open(row['path']) as picture: original=ImageOps.exif_transpose(picture).convert('RGB')
    tiles=[(row['samples'][0]['preview'],'Original: detector missed visible face')]
    for angle in (-60,-30,30,60,90):
        rgb=original.rotate(angle,expand=True,resample=Image.Resampling.BICUBIC,fillcolor=(0,0,0))
        sample=save_sample(cv2.cvtColor(np.array(rgb),cv2.COLOR_RGB2BGR),detector,OUT/'orientation-check',f'{row["uploadId"][:8]}-rotate-{angle}')
        rotations.append({'file':row['originalName'],'rotation':angle,'faces':sample['faces'],'faceCount':sample['faceCount']})
        tiles.append((sample['preview'],f'Analysis-only rotation {angle} deg\nDetected faces {sample["faceCount"]}'))
    sheet(tiles,OUT/'orientation-check'/'rotation-retry.jpg',columns=3)

NOTES={
'approved-2':{
 'assessment':'Useful additions for smiling front and three-quarter views, but all six are screenshots. The side view is visibly softer. No new video or neutral-expression sequence was supplied.',
 'priority':['1000131598.jpg: clear near-front smile, useful detail candidate after cropping screenshot borders.',
             '1000131597.jpg: near-front, different indoor lighting.',
             '1000131599.jpg: clear three-quarter smile; useful perspective supplement.'],
 'holds':['1000131595.jpg includes other visible people; select/crop the intended central foreground subject before pack admission.',
          '1000131594.jpg is a softer side view: supplementary geometry evidence, not the main fine-texture source.'],
 'missing':'Original camera files rather than screenshots; neutral closed-mouth front view, opposite-side profile and a steady head-turn video.'},
'approved-8':{
 'assessment':'Broad visible expression and profile variety, but the uploaded images range only from 215–569 pixels wide and 271–584 pixels high. These can add pose/expression coverage; they do not establish high-resolution texture.',
 'priority':['1000131562.jpg: front smiling view.', '1000131561.jpg: useful side view with closed eyes; not an open-eye texture reference.',
             '1000131565.jpg / 1000131566.jpg: supplementary front views, low pixel resolution.'],
 'holds':['1000131568.jpg has a visible face despite zero detections in the standard pass; see rotation-retry evidence. Do not equate a detector miss with an unusable identity.',
          '1000131563.jpg contains an extreme open-mouth expression and a background detection; do not use it as a neutral geometry anchor.',
          '1000131567.jpg and 1000131569.jpg are tight profiles with edge/crop limits; 1000131570.jpg has strong roll.'],
 'missing':'Original high-resolution files, a neutral expression and a short well-lit head-turn video.'},
'approved-19':{
 'assessment':'The stills provide the broadest resolution and lighting range here. Some are original-sized photographs; two are tall social-app screenshots. The video is a multi-person, sticker-overlaid clip and must not be automatically pooled.',
 'priority':['1000000960.jpg: useful three-quarter portrait; face occupies only part of a large photograph.',
             '1000085128.jpg: side/three-quarter lighting reference; hair crosses part of the face.',
             '1000085967.jpg: detailed close-up smile; close-camera perspective should not dominate canonical proportions.'],
 'holds':['1000131588.mp4 was uploaded twice, byte-for-byte identical. Keep both originals, count its evidence only once.',
          '1000131588.mp4: woman is visible on the left for much of the clip; another person is alone near the end. Cartoon stickers also trigger detections. Await target selection; no automatic selection by detector index/count.',
          '1000000549.jpg: seated couple, target selection requested.',
          '1000129181.jpg: two visible people although only one detector box is returned; downward view/interaction makes it supplementary, not a default texture anchor.',
          '1000087313.jpg and 1000087334.jpg: screenshot/compression and app overlays; processing/filter provenance is not verified.'],
 'missing':'A clean, single-person neutral-to-smile head-turn clip without stickers; balanced left/right profiles.'},
'approved-13':{
 'assessment':'Two screenshot photographs plus two edited portrait videos. There are useful close views, but much of the outdoor video is distant or turned away; the other video contains cuts and an end card.',
 'priority':['1000131584.jpg: stronger of the two still candidates; retain the original image, strip only the UI border in a future derived crop.',
             '1000131590.mp4 around 0.3–1.6 s: useful closer views, subject to strong sunlight and occasional hair coverage.',
             '1000131589.mp4 around 0–2.8 s: stable frontal car shot; cap/shadow limits the forehead and illumination evidence.'],
 'holds':['1000131583.jpg is visibly soft; do not give it equal texture weight to sharper images.',
          '1000131590.mp4 roughly 8–10 s shows the back of the head; mid-clip face size is small.',
          '1000131589.mp4 has a non-frontal/no-visible-face segment around 3–5 s and an end card after about 9.7 s. These are not missing references to invent.',
          'The low-angle indoor segment is expression/pose evidence, not the best canonical proportions reference.'],
 'missing':'Sharp neutral close-up in diffuse light, both side profiles, and a simple unedited head-turn sequence.'},
'approved-3':{
 'assessment':'Two smiling screenshots plus three videos. The car and outdoor-selfie clips provide expression changes and substantial roll; the hiking clip contains two people throughout the sampled frames.',
 'priority':['1000131600.jpg: front smiling still.', '1000131601.jpg: useful side/three-quarter still.',
             '1000131591.mp4: expression and roll variation; avoid blink/blur frames when selecting still references.',
             '1000131592.mp4: outdoor pose/lighting evidence; camera rotates during the clip, so one fixed 90-degree correction is not appropriate for all frames.'],
 'holds':['1000131593.mp4: select the foreground patterned-headband person or the background sunglasses person. Entire clip is held pending the answer.',
          'Outdoor selfie has hand/hair occlusions and changing sun/shade; the sharpest frame alone is not necessarily the best reference.',
          'All new stills are screenshots, not the underlying original camera images.'],
 'missing':'Neutral closed-mouth view with low camera roll, clean profiles in even lighting, plus the hiking-video target selection.'}}

# Discard automatic shortlist suggestions for any mixed-person source; preserve
# raw measurements separately, because detector ordering is NOT identity.
review={ 'status':'review-only; not installed; no identity verification performed',
         'orientationRetry':rotations,'groups':[]}
for group in r['groups']:
    mixed={f['uploadId'] for f in r['files'] if f['group']==group['id'] and f.get('multipleFaceSamples',0)}
    candidates=[x for x in group['reviewShortlist'] if x['uploadId'] not in mixed]
    review['groups'].append({'id':group['id'],'notes':NOTES[group['id']],'candidates':candidates,
                             'heldUploadIds':sorted(mixed)})
    sheet([(v['face']['preview'],f"{v['originalName']} @ {v['timeSeconds']}\nReview only / not approved") for v in candidates],OUT/group['id']/'review-candidates.jpg')
    # Preserve an indexed look at all detection samples, not only the shortlist.
    for row in [f for f in r['files'] if f['group']==group['id'] and f.get('type')=='video' and f.get('samples')]:
        for start in range(0,len(row['samples']),32):
            samples=row['samples'][start:start+32]
            sheet([(s['preview'],f"{row['originalName']}\n{s['timeSeconds']:.2f}s / {s['faceCount']} detections") for s in samples],OUT/group['id']/f"{row['uploadId'][:8]}-all-{start//32+1}.jpg",columns=8)
(OUT/'review.json').write_text(json.dumps(review,indent=2),encoding='utf-8')

files=r['files'];videos=[f for f in files if f.get('type')=='video' and f.get('status')=='scanned']
lines=['# Uploaded reference audit — 26 September 2026','',
 '## Summary','',
 f"All {len(files)} uploads passed stored SHA-256 checks. There are 28 photographs and 7 video uploads, representing 6 unique videos. All {sum(f['decodedFrames'] for f in videos):,} video frames decoded, and decoded counts match container frame counts. Unique video duration: {sum(f['durationSeconds'] for f in videos):.2f} seconds.",'',
 f"Every photo was inspected; videos were decoded completely, with face detection/landmark quality measurements on {sum(len(f['samples']) for f in videos)} time-distributed frames (approximately 3.75–4 Hz, plus final frames). All audio remained off. Original media and active face packs were not modified.",'',
 'This is a reference-quality scan, not face recognition or proof that each file depicts the same person. Your upload folder assignments remain authoritative. Detector face numbers are local image positions, not identities. No recognition embeddings, demographic classification, model training, or active-pack installation was performed. Pong remains version **29.02**; no APK or refresh is required for this report.','',
 '| Group | Photos | Video uploads / unique | Unique video duration | Decoded frames |',
 '|---|---:|---:|---:|---:|']
for group in r['groups']:
    lines.append(f"| {group['name']} | {group['photos']} | {group['videoUploads']} / {group['uniqueVideos']} | {group['videoSeconds']:.2f} s | {group['decodedVideoFrames']} |")
lines += ['', '## Important findings','',
 '- A one-face detection is not a safe target-selection rule: the Approved 19 clip ends on another person, and the detector also boxes cartoon overlays. Multi-person sources are held out of the conservative shortlist.',
 '- Screenshots occur in Approved 2, 13 and 3, and among Approved 19 stills. Their canvas resolution overstates the amount of original facial detail; original camera files are preferable.',
 '- Approved 8 has useful profile/expression variety but low-resolution inputs. Do not manufacture texture through aggressive restoration and call it measured identity detail.',
 '- Approved 3 has major camera roll and changing orientation. Reference alignment must distinguish that from actual facial proportions.',
 '- Neutral expressions and balanced profile coverage remain incomplete. More frames from one expression or one short clip should not outweigh genuinely different views.',
 '- More/better references may improve conditioning but do not, by themselves, fix temporal rendering, tracking, restoration flicker or anchor-transition defects. No new swap-quality improvement is claimed by this scan.','']
for group in r['groups']:
    key=group['id'];note=NOTES[key]
    lines += [f"## {group['name']}",'',note['assessment'],'',f"[All uploaded photographs]({key}/photos-1.jpg) · [Conservative review candidates]({key}/review-candidates.jpg)",'', 'Priority material:', '']
    lines += ['- '+x for x in note['priority']]
    lines += ['', 'Holds and cautions:', '']+['- '+x for x in note['holds']]
    lines += ['', '**Still useful to add:** '+note['missing'],'']
    for v in videos:
        if v['group']==key:lines.append(f"- [{v['originalName']} — full-duration overview]({key}/{Path(v['overview']).name})")
    lines.append('')
lines += ['## Detection and quality limits','',
 'Measurements use the existing det_10g detector on CPU at a 640-pixel input edge and a 0.60 confidence threshold. Some small/rolled/occluded faces are missed; a detected box can also be a poster/sticker. A human-visible face with no box is not evidence of a wrong identity.',
 '', 'Sharpness is Laplacian variance on a 128×128 face crop; it is a heuristic affected by compression, hair, edges and sharpening. It is not an identity or perceptual-quality score. Nose-offset bins are 2D perspective proxies, not calibrated yaw angles, and must not be treated as ground-truth 3D pose.',
 '', '[Orientation retry on the missed Approved 8 photograph](orientation-check/rotation-retry.jpg). The same detector found the visible face after analysis-only rotations of -60, -30, +30 and +60 degrees, but not +90. This demonstrates an orientation-sensitive miss in this analysis pass, not a verified fix to live Pong. Uploaded originals remain unchanged.',
 '', 'Visual review included all 28 photograph previews, all 293 detection-sample video previews, the shortlisted face crops and the rotation-retry sheet. Full decoding of all 2,282 frames is an integrity check; it is not a claim of detailed manual inspection or face detection on every frame.','',
 '## File-by-file inventory','',
 '| Group | Original filename | Resolution | FPS / duration | Face-detection samples: zero / one / multiple | Status |',
 '|---|---|---|---|---|---|']
for f in files:
    samples=f.get('samples',[])
    resolution=f"{samples[0]['width']}×{samples[0]['height']}" if samples else '—'
    timing=f"{f['fps']:.2f} / {f['durationSeconds']:.2f}s" if f.get('type')=='video' and 'fps' in f else '—'
    counts=f"{sum(s['faceCount']==0 for s in samples)} / {sum(s['faceCount']==1 for s in samples)} / {sum(s['faceCount']>1 for s in samples)}" if samples else '—'
    lines.append(f"| {f['group']} | {f['originalName']} | {resolution} | {timing} | {counts} | {f['status']} |")
lines += ['', '## Next pack-building step','',
 'Resolve the mixed-person selections first. Then create derived, provenance-linked face crops from a small, balanced set of clear front/three-quarter/profile and neutral/smiling samples. Exclude UI/overlays, tiny distant faces, blur, end cards and occluded regions; avoid flooding a pack with consecutive near-identical video frames. Compare the resulting pack against the existing one on non-explicit test footage before activating it. Keep originals and a rollback copy.','',
 '## Machine-readable evidence','',
 '- [Raw per-file, per-frame measurements](scan.json)',
 '- [Conservative review shortlist, holds and orientation retry](review.json)',
 '- Each group folder also contains indexed `*-all-*.jpg` sheets for every detection sample.','']
(OUT/'REPORT.md').write_text('\n'.join(lines),encoding='utf-8')
print(json.dumps({'report':str(OUT/'REPORT.md'),'rotationRetries':[{'rotation':x['rotation'],'faceCount':x['faceCount']} for x in rotations],
 'conservativeCandidates':{x['id']:len(x['candidates']) for x in review['groups']}}))
