"""Pack all saved consecutive-frame spike sheets for silent visual review."""
import json
from pathlib import Path
import cv2
import numpy as np

root = Path(__file__).resolve().parent / 'benchmarks/v2901-audit/final-paired-quality'
report = json.loads((root/'report.json').read_text(encoding='utf-8'))
destination = root/'overviews'
destination.mkdir(exist_ok=True)
for clip in report['clips']:
    for side in ('baseline','candidate'):
        files = clip[side+'SpikeSheets']
        for page, start in enumerate(range(0,len(files),8)):
            tiles=[]
            for name in files[start:start+8]:
                tile=cv2.resize(cv2.imread(name),(800,320))
                title=np.zeros((26,800,3),dtype=np.uint8)
                cv2.putText(title,f'{side}: {Path(name).name}',(4,19),cv2.FONT_HERSHEY_SIMPLEX,.5,(255,255,255),1)
                tiles.append(np.concatenate((title,tile),axis=0))
            if len(tiles)%2:
                tiles.append(np.zeros_like(tiles[0]))
            montage=np.concatenate([np.concatenate(tiles[i:i+2],axis=1) for i in range(0,len(tiles),2)],axis=0)
            path=destination/f'{Path(clip["clip"]).stem}-{side}-{page+1}.jpg'
            cv2.imwrite(str(path),montage)
            print(path)
