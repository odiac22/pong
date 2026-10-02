"""Multi-only hair admission, measured on ORIGINAL segmented hair pixels.

Unknown/mixed/occluded evidence permits ranking all selected approved sources.
This does not infer hair from face embeddings, skin, or background brightness.
"""
import re
import cv2
import numpy as np

from pong_face_roster import rule as _roster_rule

HAIR_CATEGORIES = ('black', 'brown', 'light', 'colorful')

def required_hair(face_id):
    # The engine measures target hair (and, since 1.9, skin) whenever this is
    # truthy. With hair profiles present, every Multi Face source is hair-ranked.
    from pong_hair_profile import source_profile
    return ('rule' if _roster_rule(face_id) else None) or ('profile' if source_profile(face_id) else None)

def hair_allows(face_id, color, confidence):
    """Owner roster rules (pong_face_roster). Unmeasured evidence never blocks."""
    found=_roster_rule(face_id)
    if not found:
        return True
    allowed_hair=found.get('hair')
    hair_known = color in HAIR_CATEGORIES and np.isfinite(confidence) and confidence >= .80
    if allowed_hair is not None and hair_known and str(color) not in allowed_hair:
        return False
    skin=getattr(color,'skin',None) or {}
    if found.get('skin')=='dark' and skin.get('category')=='light':
        return False
    return True

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
    color = HairColor(category, lab)
    try:
        color.skin = skin_tone(crop_rgb, hair_probability)
    except Exception:
        color.skin = {'category': 'unknown'}
    return (color, confidence)

# head_crop puts the eyes 1.25 eye-distances above centre on a crop 6.5
# eye-distances wide, so in the 512 px crop: eye distance ~79 px, eyes at y~158.
_EYE_D = 512 / 6.5
_EYE_Y = 256 - 1.25 * _EYE_D

def skin_tone(crop_rgb, hair_probability):
    """Cheek skin tone from the same crop, no extra inference.

    Uses the Individual Typology Angle, ITA = atan((L*-50)/b*). Calibrated on
    the approved photos: dark-skinned Ash/Moni/24 median 8-23, light-skinned
    faces 42-66. 'light' (>= 35) is the only category a dark-skin rule blocks;
    'medium' (28-35) stays allowed because lighting moves single frames.
    Hair-covered, clipped or too-small samples return 'unknown'.
    """
    probability = np.asarray(hair_probability)
    if crop_rgb.shape != (512, 512, 3) or probability.shape != (512, 512):
        return {'category': 'unknown'}
    y = int(_EYE_Y + .75 * _EYE_D)
    half = 15
    pixels = []
    for x in (int(256 - .55 * _EYE_D), int(256 + .55 * _EYE_D)):
        patch = crop_rgb[y-half:y+half, x-half:x+half]
        clear = np.asarray(probability[y-half:y+half, x-half:x+half]) < .5
        pixels.append(patch[clear])
    pixels = np.concatenate(pixels) if pixels else np.empty((0, 3), np.uint8)
    if len(pixels) < 300:
        return {'category': 'unknown'}
    lab = cv2.cvtColor(pixels.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB).reshape(-1, 3).astype(np.float32)
    lightness = lab[:, 0] * 100 / 255
    usable = (lightness > 8) & (lightness < 97)
    if np.count_nonzero(usable) < 300:
        return {'category': 'unknown'}
    L = float(np.median(lightness[usable]))
    b = float(np.median(lab[usable, 2] - 128))
    if b < 4:
        # Skin always has a warm b*; grey/blue values mean coloured lighting.
        return {'category': 'unknown', 'L': round(L, 1), 'b': round(b, 1)}
    ita = float(np.degrees(np.arctan2(L - 50, b)))
    category = 'dark' if ita < 28 else 'medium' if ita < 35 else 'light'
    return {'category': category, 'ita': round(ita, 1), 'L': round(L, 1), 'b': round(b, 1)}

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
    confidence=float(np.mean(probability[mask]))
    # Dyed green/blue/purple/pink (natural hair hues are red-orange-yellow).
    if np.mean((hsv[:,1]>120)&(hsv[:,0]>35)&(hsv[:,0]<170))>.25:return ('colorful',confidence)
    q25,median,q75=np.percentile(lab,[25,50,75])
    # Roots and shadows do not make highlighted/blonde hair uniformly bright.
    # Use robust distributions, retaining an explicit intermediate/ambiguous band.
    # 1.9: owner rules separate black from brown hair.
    if median<=25 and q75<=40:return ('black',confidence)
    if median<=38 and q75<=48:return ('brown',confidence)
    # Substantial light lengths can coexist with >25% genuinely dark roots.
    # Require a majority of bright segmented hair, never a few highlights.
    if median>=45 and q75>=56 and (q25>=25 or np.mean(lab>=50)>=.60):
        return ('light',confidence)
    # Coloured lighting suppresses luminance even on blonde hair. Require a
    # broad bright distribution, not isolated highlights; hue gates still apply.
    value25,value50,value75=np.percentile(hsv[:,2],[25,50,75])
    if median>=38 and q25>=25 and value25>=135 and value50>=170 and value75>=190:
        return ('light',confidence)
    # Medium brown. 36-45 stays ambiguous: Lau's own reference hair measures
    # L* 41 (dark blonde), so calling it brown would block her look-alikes.
    if median<36:return ('brown',confidence)
    return ('unknown',0.)
