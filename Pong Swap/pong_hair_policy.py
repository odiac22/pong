"""Multi-only hair admission, measured on ORIGINAL segmented hair pixels.

Unknown/mixed/occluded evidence permits ranking all selected approved sources.
This does not infer hair from face embeddings, skin, or background brightness.
"""
import re
import cv2
import numpy as np

HAIR_RULES = {2:'dark',3:'dark',8:'light',13:'dark',19:'light',23:'dark'}

def _hard_rule(face_id):
    match=re.fullmatch(r'approved-(\d+)(?:-[0-9a-f]{12})?',str(face_id))
    return HAIR_RULES.get(int(match.group(1))) if match else None

def required_hair(face_id):
    # Baseline 1.6: the engine measures target hair whenever this is truthy.
    # With hair profiles present, every Multi Face source is hair-ranked.
    from pong_hair_profile import source_profile
    return _hard_rule(face_id) or ('profile' if source_profile(face_id) else None)

def hair_allows(face_id, color, confidence):
    required=_hard_rule(face_id)
    uncertain = color not in ('dark', 'light') or not np.isfinite(confidence) or confidence < .80
    return required is None or uncertain or color == required

def head_crop(frame, keypoints):
    points=np.asarray(keypoints,dtype=np.float32)
    if points.shape!=(5,2) or not np.isfinite(points).all():return None
    eyes=points[:2].mean(axis=0);distance=float(np.linalg.norm(points[1]-points[0]))
    if distance<12:return None
    # Include the lengths beside/below the face, not only the crown/roots.
    # Dark roots on blonde/ombre hair otherwise dominate the entire sample.
    # Same one 512px parser call: broader original context, no extra inference.
    side=distance*6.5;center=eyes+np.array([0.,1.25*distance])
    x,y=center-side/2
    height,width=frame.shape[:2]
    # Use only captured pixels, never replicated border padding as dark hair.
    x0,y0=max(0,int(x)),max(0,int(y))
    x1,y1=min(width,int(x+side)),min(height,int(y+side))
    if (x1-x0)*(y1-y0)<side*side*.50:return None
    return cv2.resize(frame[y0:y1,x0:x1],(512,512),interpolation=cv2.INTER_AREA)

def segmented_hair_score(logits):
    """Hair-vs-strongest-alternative separation, not calibrated probability.

    The parser is an argmax segmenter. A 19-way softmax .8 cutoff discarded
    clear hair winners (94 pixels versus 77k on a captured tinted-light frame).
    Require a >= log(4) margin over EVERY competing class, then erosion and
    minimum area. Never sample unsegmented background. Remains on the tensor's
    device and owned stream; called only during target acquisition.
    """
    import torch
    other = torch.maximum(logits[:17].amax(dim=0), logits[18])
    return torch.sigmoid(logits[17] - other)


def color_from_hair_mask(crop_rgb, hair_probability):
    # Baseline 1.6: same category result, now carrying the measured colour.
    from pong_hair_profile import HairColor, hair_lab
    category, confidence = _category_from_hair_mask(crop_rgb, hair_probability)
    try:
        lab = hair_lab(crop_rgb, hair_probability)
    except Exception:
        lab = None
    return (HairColor(category, lab), confidence)

def _category_from_hair_mask(crop_rgb, hair_probability):
    probability=np.asarray(hair_probability)
    if crop_rgb.shape!=(512,512,3) or probability.shape!=(512,512):return ('unknown',0.)
    mask=np.isfinite(probability)&(probability>=.80)
    # Keep the central head/lengths, excluding crop edges. Shoulders/skin are
    # excluded by segmentation, not by cutting away the lower half of hair.
    region=np.zeros((512,512),bool);region[16:496,60:452]=True
    mask &= region
    mask=cv2.erode(mask.astype(np.uint8),np.ones((3,3),np.uint8),iterations=1).astype(bool)
    if np.count_nonzero(mask)<400:return ('unknown',0.)
    pixels=crop_rgb[mask]
    # Reject severe underexposure/clipping and strongly dyed hues rather than
    # confidently assigning them to the wrong natural light/dark category.
    if np.max(crop_rgb)<35 or np.mean(np.min(pixels,axis=1)>250)>.35:return ('unknown',0.)
    lab=cv2.cvtColor(crop_rgb,cv2.COLOR_RGB2LAB)[mask,0].astype(np.float32)*100/255
    hsv=cv2.cvtColor(crop_rgb,cv2.COLOR_RGB2HSV)[mask]
    if np.mean((hsv[:,1]>120)&(hsv[:,0]>35)&(hsv[:,0]<170))>.25:return ('unknown',0.)
    q25,median,q75=np.percentile(lab,[25,50,75])
    confidence=float(np.mean(probability[mask]))
    # Roots and shadows do not make highlighted/blonde hair uniformly bright.
    # Use robust distributions, retaining an explicit intermediate/ambiguous band.
    if median<=38 and q75<=48:return ('dark',confidence)
    # Substantial light lengths can coexist with >25% genuinely dark roots.
    # Require a majority of bright segmented hair, never a few highlights.
    if median>=45 and q75>=56 and (q25>=25 or np.mean(lab>=50)>=.60):
        return ('light',confidence)
    # Coloured lighting suppresses luminance even on blonde hair. Require a
    # broad bright distribution, not isolated highlights; hue gates still apply.
    value25,value50,value75=np.percentile(hsv[:,2],[25,50,75])
    if median>=38 and q25>=25 and value25>=135 and value50>=170 and value75>=190:
        return ('light',confidence)
    return ('unknown',0.)
