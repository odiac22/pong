"""Grade independently labelled Multi face observations; never invent labels.

This is an evaluator, not a trained model or a substitute for rendered-video QA.
Use consented/licensed footage, hash original assets, and keep source/identity
families separate between calibration and held-out evaluation. Source-reference
hashes, duplicates, unreviewed labels and missing observations cannot pass.
"""
import argparse
from collections import Counter
import json
from pathlib import Path


def evaluate(manifest, observations):
    approved = set(manifest['approvedFaceIds'])
    if len(approved) < 2:
        raise ValueError('Multi face requires at least two approved source choices')
    cases = manifest['cases']
    reference_hashes = set(manifest.get('referenceAssetHashes', []))
    seen_ids, seen_hashes = set(), set()
    splits = {}
    rows = []
    for item in cases:
        ident, checksum, group = item['id'], item['sha256'], item['sourceGroup']
        if ident in seen_ids or checksum in seen_hashes:
            raise ValueError('Duplicate test ID or original asset cannot inflate coverage')
        seen_ids.add(ident)
        seen_hashes.add(checksum)
        if len(checksum) != 64 or any(c not in '0123456789abcdef' for c in checksum):
            raise ValueError('Original asset SHA-256 is required')
        if checksum in reference_hashes:
            raise ValueError('Approved reference material cannot be a held-out matching test')
        if item['split'] not in ('calibration', 'heldout') or not group:
            raise ValueError('Explicit split and source family required')
        if group in splits and splits[group] != item['split']:
            raise ValueError('Source/identity family leaks across calibration and held-out split')
        splits[group] = item['split']
        if item['kind'] not in ('clip', 'image') or not item.get('licenseOrConsent'):
            raise ValueError('Licensed/consented clip or image required')
        allowed = set(item.get('acceptableFaceIds', []))
        if not allowed <= approved:
            raise ValueError('Labels must refer to the selected approved sources')
        independently_reviewed = item.get('labelSource') == 'independent-review'
        observation = observations.get(ident, {})
        selected = observation.get('selectedFaceId')
        sequence = [x for x in observation.get('selectedFaceSequence', []) if x]
        stable = len(set(sequence)) <= 1 and (not sequence or selected == sequence[-1])
        # The benchmark must offer *all* sources, not just the expected winner.
        all_offered = set(observation.get('offeredFaceIds', [])) == approved
        expected_abstention = not allowed and item.get('expectNoMatch') is True
        matches = (selected in allowed if allowed else expected_abstention and selected is None)
        rendered = observation.get('transformed') is True if selected else observation.get('transformed') is False
        passed = bool(independently_reviewed and all_offered and stable and matches and rendered)
        rows.append(dict(id=ident, kind=item['kind'], split=item['split'], passed=passed,
            reviewed=independently_reviewed, observed=bool(observation), stable=stable,
            allSourcesOffered=all_offered, selectedFaceId=selected,
            acceptableFaceIds=sorted(allowed), matches=matches))
    heldout = [r for r in rows if r['split']=='heldout']
    counts = Counter(r['kind'] for r in heldout)
    correct_per_face = Counter(r['selectedFaceId'] for r in heldout if r['passed'] and r['selectedFaceId'])
    coverage = (counts['clip'] >= 100 and counts['image'] >= 1000 and
                all(correct_per_face[face] >= 100 for face in approved))
    return dict(scope='held-out source-choice accuracy and stability; NOT perceptual swap quality or playback speed',
        heldoutClips=counts['clip'],heldoutImages=counts['image'],
        independentlyReviewed=sum(r['reviewed'] for r in heldout),
        missingObservations=sum(not r['observed'] for r in heldout),
        perFaceCorrect={face:correct_per_face[face] for face in sorted(approved)},
        coverageRequirementsMet=coverage,
        allRequiredPassed=bool(coverage and heldout and all(r['passed'] for r in heldout)),cases=rows)


if __name__ == '__main__':
    parser=argparse.ArgumentParser()
    parser.add_argument('--manifest',type=Path,required=True)
    parser.add_argument('--observations',type=Path,required=True)
    parser.add_argument('--out',type=Path,required=True)
    args=parser.parse_args()
    result=evaluate(json.loads(args.manifest.read_text()),json.loads(args.observations.read_text()))
    args.out.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k!='cases'}))
