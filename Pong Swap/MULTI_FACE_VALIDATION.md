# Multi face validation — 30.37 candidate

Implementation is not a trained/qualified matching model. It ranks visual
resemblance, not a person's real-world identity. Single-source rendering and
quality settings are unchanged. The running 30.30 service does not yet use the
new Multi face policy.

## Behaviour

- Offer up to 16 approved source faces. Score using the existing feature-led
  identity metric, not detector order or colour-dominant acquisition ranking.
- Require a winner margin and consistent target evidence over at least 40 ms
  of source time. A tie or no compatible face stays original.
- Retain one approved source per video/selected-set/client-epoch/config revision,
  including seeks, in a bounded expiring cache. Do not carry target tracking or
  pixels across seeks. Verify the current target again.
- Reject stale video residuals through the existing cut/identity/occlusion
  protections. These guards do not replace perceptual video inspection.

The 2-point winner margin is a conservative initial parameter, not empirically
calibrated 100% accuracy. Twelve focused unit tests cover order, ambiguity,
colour disagreement, elapsed-time consensus at varied FPS and bounded choice
memory. They are not 100 independently graded clips or 1000 images.

## Required corpus and labels

Use consented/licensed, non-explicit footage. Confirm which approved source IDs
belong in the requested source set; do not infer gender identity from photos.
Reference uploads are inputs, not independent held-out success examples.

For every original asset record:

- unique `id`, `kind` (`clip` or `image`), actual lowercase original-file
  `sha256`, and a `sourceGroup` for related identity/shoot/video material;
- `split` (`calibration` or `heldout`) and `licenseOrConsent` provenance;
- independently reviewed `acceptableFaceIds`, with `labelSource` set to
  `independent-review`; an intentional no-match case uses an empty list and
  `expectNoMatch: true`.

The manifest has top-level `approvedFaceIds`, `referenceAssetHashes` and `cases`.
Do not create ground-truth labels by asking the same score being evaluated to
name its own winner. Similar-looking choices may justify more than one accepted
label. If so, document the ambiguity instead of forcing an arbitrary answer.

Record actual observations keyed by case ID, with `offeredFaceIds` (the complete
source set), `selectedFaceId`, `selectedFaceSequence` and `transformed` evidence.
Evaluate with `benchmark_multi_face_labels.py --manifest <path> --observations
<path> --out <path>`. It rejects duplicate original assets, reference leakage,
source-family split leakage, missing labels and incomplete observations.

The coverage gate requires at least 100 held-out clips, 1000 held-out images and
100 correctly graded distinct examples for every selected approved source.
Different frames/augmentations of one source are not independent identities or
independent clips. When tuning repeatedly, use calibration data and preserve an
untouched final holdout; tuning against every reported test invalidates a
generalisation claim.

Source-choice accuracy is only one gate. Separately inspect consecutive rendered
frames for identity continuity, pose/expression fidelity, occlusion handling and
temporal artifacts. Measure moving-video latency/buffering in Pong, not just a
still response. No dataset-accuracy or perceptual-quality pass is claimed yet.
