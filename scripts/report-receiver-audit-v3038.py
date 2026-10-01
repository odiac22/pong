"""Summarize actual receiver evidence without treating ACKs as visible latency."""
import json
from pathlib import Path
from statistics import median
from PIL import Image, ImageDraw

ROOT = Path(r'E:\Pong Benchmarks\v3038-detect')
run = ROOT / 'receiver-15-swipes-guarded'
data = json.loads((run / 'report.json').read_text())
rows = data['phases']
times = [r['swap']['firstSwappedFrameMs'] for r in rows if r['swap']['firstSwappedFrameMs'] is not None]
acks = [v for r in rows for v in r['inputAckMs']]
summary = {
    'applicationVersion': '30.38', 'swipeGesturesCompleted': len(rows),
    'newVideosIndividuallyQualified': False,
    'firstPcSwapPresentCount': len(times), 'firstPcSwapMissingCount': len(rows)-len(times),
    'firstPcSwapUnder1000MsCount': sum(v < 1000 for v in times),
    'firstPcSwapMedianMs': median(times), 'firstPcSwapMaxMs': max(times),
    'inputRpcAckMedianMs': median(acks), 'inputRpcAckMaxMs': max(acks),
    'phoneVisibleResponseQualified': False, 'transportImageQualityQualified': False,
    'qualityConfigUnchanged': data['qualityConfigUnchanged'], 'quality': data['quality'],
    'sourceResolution': [data['firstReceiverFrame']['width'],data['firstReceiverFrame']['height']],
    'audioPlayed': False, 'backgroundDownloadActive': True,
    'performanceGatesPassed': False,
    'notes': ['Source TikTok ANR invalidated an earlier run; source app restarted, login preserved.',
              'PC swap completion is not receiver presentation or fresh model-inference FPS.',
              'Snapshot frame counts include keepalives and original passthrough.',
              'Missing swap may mean no eligible face; must be individually diagnosed, not counted as pass.',
              'H264 exploratory run was not a controlled same-video quality comparison and was not promoted.']
}
(ROOT/'receiver-summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
sheet=Image.new('RGB',(5*260,3*600),'#15171b')
draw=ImageDraw.Draw(sheet)
for index,row in enumerate(rows):
    file=run/row['screenshot']
    with Image.open(file) as im:
        im.thumbnail((260,563))
        x,y=(index%5)*260,(index//5)*600
        sheet.paste(im,(x,y+32))
        value=row['swap']['firstSwappedFrameMs']
        label=f"{row['ordinal']}: PC swap {value:.0f} ms" if value is not None else f"{row['ordinal']}: no swap at checkpoint"
        draw.text((x+4,y+8),label,fill='white')
sheet.save(ROOT/'receiver-15-contact-sheet.jpg',quality=93)
print(json.dumps(summary,indent=2))
