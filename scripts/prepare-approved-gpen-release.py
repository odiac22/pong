"""Prepare immutable release metadata. Does not change settings or restart Pong."""
import hashlib
import json
from pathlib import Path
import sys

repo = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(repo / 'Pong Swap/engine/Rope'))
from rope.gpen_user_review import SCHEMA, PLAN_SHA, MODEL_SHA, POLICY, validate

root = Path('E:/Pong Benchmarks/user-quality-review-2026-09-30')
plan = root / 'gpen1024-fp16-islands-7-9-11-13-15-r3/candidate.plan'
identity = dict(modelSha256=MODEL_SHA, edge=1024, tensorrt='10.16.1.11',
                cuda='12.8', gpu='NVIDIA GeForce RTX 4070', capability=[8, 9],
                tf32=False, int8=False)
evidence = {}
for name, directory in [('build', plan.parent.name), ('review', 'approved8-fp16-islands-r3'),
                        ('combined', 'approved8-combined-core-r1')]:
    path = root / directory / 'report.json'
    evidence[name] = dict(path=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())
manifest = dict(schema=SCHEMA, plan=str(plan), planSha256=PLAN_SHA,
                **identity, precisionPolicy=POLICY, workspaceBytes=4 << 30,
                approval='user-approved-2026-09-30', evidence=evidence,
                approvalText='Yes implement these i kike it',
                qualificationScope='Human visual approval and five-clip operational review; not FP32 numerical equivalence')
validate(manifest, identity, plan, plan.read_bytes())
path = Path(str(plan) + '.manifest.json')
payload = json.dumps(manifest, indent=2).encode()
if path.exists():
    if path.read_bytes() != payload:
        raise RuntimeError('Existing release manifest differs; refusing overwrite')
else:
    with path.open('xb') as stream:
        stream.write(payload)
print(json.dumps(dict(manifest=str(path), planSha256=PLAN_SHA, settingsChanged=False)))
