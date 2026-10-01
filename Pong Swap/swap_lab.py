from __future__ import annotations

import hashlib
import csv
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

from benchmark_restorers_stock import RESTORER_SPECS
from benchmark_swappers_stock import CUDA_DLL_ROOT, FACEFUSION, MODEL_SPECS, PYTHON, ROOT, VENDOR_ROOT


# Compare mode is intentionally a different process and port from Pong's
# production/background control planes. Its subprocesses may load any model,
# but their ORT arenas die with the subprocess and can never accumulate in the
# long-lived production worker.
PORT = int(os.environ.get("PONG_SWAP_LAB_PORT", "8796"))
PRODUCTION_HEALTH_URL = os.environ.get(
    "PONG_SWAP_PRODUCTION_HEALTH_URL",
    "http://127.0.0.1:8787/pong-swap/health",
)
FACE_ROOT = ROOT / "approved-faces"
TARGET = ROOT / "benchmarks" / "visual-checks" / "target.png"
CACHE_ROOT = ROOT / "cache" / "swap-lab-v1"
MANUAL_GRADING_ROOT = ROOT / "benchmarks" / "manual-grading"
SCORE_JSONL = MANUAL_GRADING_ROOT / "swap-lab-scores.jsonl"
SCORE_CSV = MANUAL_GRADING_ROOT / "swap-lab-scores.csv"
PIPELINE_VERSION = "2026-09-18-v1"
GPU_LOCK = threading.RLock()
SCORE_LOCK = threading.RLock()

MODEL_LABELS = {
    "inswapper_128_fp16": "InSwapper 128 FP16 (current swapper)",
    "inswapper_128": "InSwapper 128 FP32",
    "alphaface_256": "AlphaFace 256",
    "hyperswap_1a_256": "HyperSwap 1A 256",
    "hyperswap_1b_256": "HyperSwap 1B 256",
    "hyperswap_1c_256": "HyperSwap 1C 256",
    "simswap_256": "SimSwap 256",
    "simswap_unofficial_512": "SimSwap 512",
    "ghost_1_256": "Ghost 1 256",
    "ghost_2_256": "Ghost 2 256",
    "ghost_3_256": "Ghost 3 256",
    "hififace_unofficial_256": "HiFiFace 256",
    "uniface_256": "UniFace 256",
    "blendswap_256": "BlendSwap 256",
}
RESTORER_LABELS = {
    "none": "No restorer",
    "gpen_bfr_512": "GPEN512 (current restorer)",
    "gpen_bfr_256": "GPEN256",
    "codeformer": "CodeFormer",
    "gfpgan_1.2": "GFPGAN 1.2",
    "gfpgan_1.3": "GFPGAN 1.3",
    "gfpgan_1.4": "GFPGAN 1.4",
    "restoreformer_plus_plus": "RestoreFormer++",
}

MODEL_BY_NAME = {spec.name: spec for spec in MODEL_SPECS}
RESTORER_BY_NAME = {spec.name: spec for spec in RESTORER_SPECS}


def production_worker_busy() -> bool:
    try:
        with urllib.request.urlopen(PRODUCTION_HEALTH_URL, timeout=1.25) as response:
            payload = json.loads(response.read().decode("utf-8", errors="replace"))
        return int(payload.get("activeSessions", 0) or 0) > 0
    except Exception:
        # The lab remains usable when Pong is intentionally offline.
        return False


def face_sources() -> dict[str, Path]:
    result: dict[str, Path] = {}
    if not FACE_ROOT.is_dir():
        return result
    for directory in sorted(FACE_ROOT.iterdir(), key=lambda item: item.name.casefold()):
        if not directory.is_dir():
            continue
        candidates = [
            path
            for path in directory.iterdir()
            if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}
        ]
        if candidates:
            result[directory.name] = sorted(candidates, key=lambda item: item.name.casefold())[0]
    return result


def safe_slug(value: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", value).strip("-.")
    return cleaned or "face"


def cache_key(face_path: Path, model: str, restorer: str) -> str:
    digest = hashlib.sha256()
    digest.update(PIPELINE_VERSION.encode())
    digest.update(model.encode())
    digest.update(restorer.encode())
    digest.update(face_path.read_bytes())
    digest.update(TARGET.read_bytes())
    return digest.hexdigest()[:20]


def result_paths(face_name: str, face_path: Path, model: str, restorer: str) -> tuple[Path, Path]:
    face_dir = CACHE_ROOT / safe_slug(face_name)
    raw_key = cache_key(face_path, model, "raw")
    final_key = cache_key(face_path, model, restorer)
    return face_dir / f"{model}--{raw_key}--raw.png", face_dir / f"{model}--{final_key}--{restorer}.png"


def run_hidden(command: list[str], timeout: int = 900) -> None:
    env = dict(os.environ)
    env["PATH"] = str(CUDA_DLL_ROOT) + os.pathsep + env.get("PATH", "")
    completed = subprocess.run(
        command,
        cwd=VENDOR_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    if completed.returncode != 0:
        detail = (completed.stdout + "\n" + completed.stderr)[-2500:].strip()
        raise RuntimeError(detail or f"render process exited {completed.returncode}")


def common(output: Path, target: Path) -> list[str]:
    return [
        str(PYTHON), str(FACEFUSION), "headless-run",
        "-t", str(target), "-o", str(output),
        "--workflow-strategy", "memory",
        "--face-mask-types", "box", "--face-mask-blur", "0.3",
        "--face-selector-mode", "one",
        "--execution-providers", "cuda", "--execution-thread-count", "1",
        "--video-memory-strategy", "tolerant",
        "--output-image-quality", "100", "--log-level", "warn",
    ]


def generate_raw(face_path: Path, model: str, output: Path) -> None:
    spec = MODEL_BY_NAME[model]
    command = common(output, TARGET)
    command[3:3] = ["-s", str(face_path)]
    command.extend([
        "--processors", "face_swapper",
        "--face-swapper-model", model,
        "--face-swapper-pixel-boost", f"{spec.native_size}x{spec.native_size}",
        "--face-swapper-weight", "0.5",
    ])
    run_hidden(command)


def generate_restored(raw: Path, restorer: str, output: Path) -> None:
    command = common(output, raw)
    command.extend([
        "--processors", "face_enhancer",
        "--face-enhancer-model", restorer,
        "--face-enhancer-blend", "100",
        "--face-enhancer-weight", "0.5",
    ])
    run_hidden(command)


def generate_combined(face_path: Path, model: str, restorer: str, output: Path) -> None:
    """Swap and restore in one FaceFusion process.

    A new process has a meaningful Python/ORT/model startup cost. Running both
    processors together removes the second process and the intermediate PNG
    decode/encode from an uncached combined request.
    """
    spec = MODEL_BY_NAME[model]
    command = common(output, TARGET)
    command[3:3] = ["-s", str(face_path)]
    command.extend([
        "--processors", "face_swapper", "face_enhancer",
        "--face-swapper-model", model,
        "--face-swapper-pixel-boost", f"{spec.native_size}x{spec.native_size}",
        "--face-swapper-weight", "0.5",
        "--face-enhancer-model", restorer,
        "--face-enhancer-blend", "100",
        "--face-enhancer-weight", "0.5",
    ])
    run_hidden(command)


def grading_image(face_name: str, category: str, filename: str) -> Path | None:
    root = MANUAL_GRADING_ROOT / face_name / category
    if not root.is_dir():
        return None
    matches = [path for path in root.rglob(filename) if path.is_file()]
    return matches[0] if len(matches) == 1 else None


def prime_existing_grading_result(
    face_name: str,
    model: str,
    restorer: str,
    raw: Path,
    final: Path,
) -> bool:
    """Reuse the already-reviewed grading images when their recipe matches."""
    raw_source = grading_image(face_name, "Models", f"{model}.png")
    if raw_source is not None and not raw.is_file():
        raw.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(raw_source, raw)
    if restorer == "none":
        return raw.is_file()
    # The original restorer grading set used InSwapper FP16 as its fixed base.
    if model != "inswapper_128_fp16":
        return False
    restored_source = grading_image(face_name, "Restorers", f"{restorer}.png")
    if restored_source is not None and not final.is_file():
        final.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(restored_source, final)
    return final.is_file()


class RenderRequest(BaseModel):
    face: str
    model: str
    restorer: str = "none"


class ScoreRequest(BaseModel):
    face: str
    model: str
    restorer: str = "none"
    score: float = Field(ge=1, le=10)


def read_scores() -> list[dict]:
    if not SCORE_JSONL.is_file():
        return []
    entries = []
    for line in SCORE_JSONL.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(item, dict):
            entries.append(item)
    return entries


def append_score(entry: dict) -> None:
    MANUAL_GRADING_ROOT.mkdir(parents=True, exist_ok=True)
    with SCORE_LOCK:
        with SCORE_JSONL.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, separators=(",", ":")) + "\n")
        write_header = not SCORE_CSV.is_file() or SCORE_CSV.stat().st_size == 0
        with SCORE_CSV.open("a", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(
                handle,
                fieldnames=("createdAt", "face", "model", "modelLabel", "restorer", "restorerLabel", "score"),
            )
            if write_header:
                writer.writeheader()
            writer.writerow(entry)


app = FastAPI(title="Pong Swap Lab", docs_url=None, redoc_url=None)


@app.get("/", response_class=HTMLResponse)
def home() -> HTMLResponse:
    return HTMLResponse(HTML)


@app.get("/health")
def health() -> dict:
    return {"ok": True, "faces": len(face_sources()), "busy": GPU_LOCK._is_owned()}


@app.get("/api/options")
def options() -> dict:
    faces = face_sources()
    return {
        "faces": [{"id": name, "label": name, "image": f"/api/face/{name}"} for name in faces],
        "models": [
            {"id": spec.name, "label": MODEL_LABELS.get(spec.name, spec.name), "native": spec.native_size}
            for spec in MODEL_SPECS
        ],
        "restorers": [
            {"id": "none", "label": RESTORER_LABELS["none"]},
            *[
                {"id": spec.name, "label": RESTORER_LABELS.get(spec.name, spec.name), "native": spec.native_size}
                for spec in RESTORER_SPECS
            ],
        ],
        "target": "/api/target",
    }


@app.get("/api/face/{face_name}")
def face_image(face_name: str) -> FileResponse:
    source = face_sources().get(face_name)
    if source is None:
        raise HTTPException(404, "approved image not found")
    return FileResponse(source, headers={"Cache-Control": "private, no-store"})


@app.get("/api/target")
def target_image() -> FileResponse:
    if not TARGET.is_file():
        raise HTTPException(404, "comparison target is missing")
    return FileResponse(TARGET, media_type="image/png", headers={"Cache-Control": "private, max-age=3600"})


@app.post("/api/render")
def render(request: RenderRequest) -> dict:
    if production_worker_busy():
        raise HTTPException(409, "Pong is actively swapping; Compare waits so it cannot steal playback VRAM")
    faces = face_sources()
    face_path = faces.get(request.face)
    if face_path is None:
        raise HTTPException(400, "unknown approved image")
    if request.model not in MODEL_BY_NAME:
        raise HTTPException(400, "unknown swapper")
    if request.restorer != "none" and request.restorer not in RESTORER_BY_NAME:
        raise HTTPException(400, "unknown restorer")
    if not TARGET.is_file():
        raise HTTPException(500, "comparison target is missing")

    raw, final = result_paths(request.face, face_path, request.model, request.restorer)
    final = raw if request.restorer == "none" else final
    started = time.perf_counter()
    prime_existing_grading_result(request.face, request.model, request.restorer, raw, final)
    cached = final.is_file()
    try:
        if not cached:
            with GPU_LOCK:
                prime_existing_grading_result(request.face, request.model, request.restorer, raw, final)
                final.parent.mkdir(parents=True, exist_ok=True)
                if request.restorer == "none":
                    if not raw.is_file():
                        generate_raw(face_path, request.model, raw)
                elif not final.is_file():
                    if raw.is_file():
                        generate_restored(raw, request.restorer, final)
                    else:
                        generate_combined(face_path, request.model, request.restorer, final)
    except subprocess.TimeoutExpired:
        raise HTTPException(504, "generation timed out")
    except Exception as exc:
        raise HTTPException(500, f"generation failed: {exc}")

    return {
        "face": request.face,
        "model": request.model,
        "modelLabel": MODEL_LABELS.get(request.model, request.model),
        "restorer": request.restorer,
        "restorerLabel": RESTORER_LABELS.get(request.restorer, request.restorer),
        "cached": cached,
        "elapsedMs": round((time.perf_counter() - started) * 1000, 1),
        "image": f"/api/result?face={request.face}&model={request.model}&restorer={request.restorer}&v={int(final.stat().st_mtime_ns)}",
    }


@app.get("/api/scores")
def scores() -> dict:
    entries = read_scores()
    latest: dict[str, dict] = {}
    for entry in entries:
        key = "|".join((str(entry.get("face", "")), str(entry.get("model", "")), str(entry.get("restorer", ""))))
        latest[key] = entry
    return {"entries": entries, "latest": latest}


@app.post("/api/scores")
def submit_score(request: ScoreRequest) -> dict:
    if request.face not in face_sources():
        raise HTTPException(400, "unknown approved image")
    if request.model not in MODEL_BY_NAME:
        raise HTTPException(400, "unknown swapper")
    if request.restorer != "none" and request.restorer not in RESTORER_BY_NAME:
        raise HTTPException(400, "unknown restorer")
    entry = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "face": request.face,
        "model": request.model,
        "modelLabel": MODEL_LABELS.get(request.model, request.model),
        "restorer": request.restorer,
        "restorerLabel": RESTORER_LABELS.get(request.restorer, request.restorer),
        "score": round(float(request.score), 2),
    }
    append_score(entry)
    return {"saved": True, "entry": entry}


@app.get("/api/result")
def result(face: str, model: str, restorer: str = "none") -> FileResponse:
    face_path = face_sources().get(face)
    if face_path is None or model not in MODEL_BY_NAME or (restorer != "none" and restorer not in RESTORER_BY_NAME):
        raise HTTPException(404, "result not found")
    raw, final = result_paths(face, face_path, model, restorer)
    path = raw if restorer == "none" else final
    if not path.is_file():
        raise HTTPException(404, "result not generated")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "private, max-age=31536000, immutable"})


HTML = r'''<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pong Swap Lab</title>
<style>
:root{color-scheme:dark;--bg:#07090d;--panel:#10141c;--line:#252c38;--muted:#929bad;--accent:#7857ff;--good:#35d07f}
*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 10% 0,#17142c 0,#07090d 42%);color:#eef2f8;font:14px Inter,Segoe UI,sans-serif;min-height:100vh}
header{display:flex;align-items:center;justify-content:space-between;padding:18px 22px;border-bottom:1px solid var(--line);position:sticky;top:0;background:#080a0ee8;backdrop-filter:blur(18px);z-index:3}h1{font-size:18px;margin:0}.sub{color:var(--muted);font-size:12px}.layout{display:grid;grid-template-columns:310px minmax(320px,1fr);gap:16px;padding:16px;max-width:1500px;margin:auto}.panel{background:#0e1219e8;border:1px solid var(--line);border-radius:16px;padding:14px;box-shadow:0 18px 45px #0005}label{display:block;color:#aeb6c5;font-weight:700;font-size:12px;margin:12px 0 6px}select,button{width:100%;border:1px solid #303848;border-radius:10px;background:#171c26;color:#f7f8fb;padding:11px;font:inherit}button{cursor:pointer;font-weight:800;background:linear-gradient(135deg,#5637db,#8b5cf6);border:0;margin-top:14px}button:disabled{opacity:.45;cursor:wait}.facePreview{width:100%;aspect-ratio:1/1;border-radius:12px;object-fit:cover;background:#050609;border:1px solid var(--line)}.stage{display:grid;grid-template-columns:1fr 1fr;gap:12px}.stage figure{margin:0;min-width:0}.stage img{width:100%;max-height:70vh;object-fit:contain;background:#050609;border:1px solid var(--line);border-radius:14px}.stage figcaption{color:var(--muted);padding:7px 2px}.status{min-height:21px;margin-top:10px;color:#b9c1d1}.status.good{color:var(--good)}h2{font-size:14px;margin:22px 0 10px}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:12px}.card{background:#0d1118;border:1px solid var(--line);border-radius:13px;overflow:hidden}.card img{width:100%;aspect-ratio:9/16;object-fit:cover;background:#050609;cursor:zoom-in}.meta{padding:10px}.meta strong{display:block;font-size:12px}.meta span{font-size:11px;color:var(--muted)}.rating{display:flex;gap:6px;align-items:center;margin-top:8px}.rating select{padding:5px;width:auto;margin-left:auto}.empty{color:var(--muted);padding:24px;text-align:center;border:1px dashed #303747;border-radius:13px}.busyDot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#697386;margin-right:7px}.busy .busyDot{background:#f2bd45;box-shadow:0 0 0 5px #f2bd4520;animation:pulse 1s infinite}@keyframes pulse{50%{opacity:.35}}dialog{padding:0;border:1px solid var(--line);border-radius:16px;background:#080a0e;max-width:92vw;max-height:92vh}dialog img{display:block;max-width:90vw;max-height:86vh}dialog button{position:absolute;right:10px;top:10px;width:auto;margin:0;background:#111827dd}@media(max-width:800px){.layout{grid-template-columns:1fr}.stage{grid-template-columns:1fr}}
.scorePanel{display:grid;grid-template-columns:auto minmax(180px,1fr) auto;align-items:center;gap:14px;margin-top:12px}.scorePanel strong{font-size:14px}.scorePanel input[type=range]{width:100%;accent-color:var(--accent)}.scorePanel button{width:auto;margin:0;padding:10px 18px}.scoreValue{font-size:24px;font-weight:900;color:#bdaeff;min-width:58px}.scoreStatus{grid-column:1/-1;color:var(--good);min-height:16px;font-size:12px}.savedScore{display:block;margin-top:7px;color:#bdaeff!important;font-weight:800}@media(max-width:650px){.scorePanel{grid-template-columns:1fr}.scorePanel button{width:100%}}
</style></head><body>
<header><div><h1>Pong Swap Lab</h1><div class="sub">Private local model + restorer comparison</div></div><div id="live"><i class="busyDot"></i><span>Ready</span></div></header>
<main class="layout"><aside class="panel">
  <img id="facePreview" class="facePreview" alt="Selected approved face">
  <label for="face">Approved image</label><select id="face"></select>
  <label for="model">Face-swap model</label><select id="model"></select>
  <label for="restorer">Restorer</label><select id="restorer"></select>
  <button id="generate">Generate combination</button><div id="status" class="status"></div>
  <div class="sub">Generated combinations stay cached locally. This does not change Pong's baseline settings.</div>
</aside><section>
  <div class="panel stage"><figure><img id="target"><figcaption>Common target</figcaption></figure><figure><img id="result"><figcaption id="resultCaption">Select a combination</figcaption></figure></div>
  <div class="panel scorePanel"><strong>Score this combination</strong><input id="scoreMeter" type="range" min="1" max="10" step="0.5" value="5" disabled><output id="scoreValue" class="scoreValue">5.0</output><button id="submitScore" disabled>Submit score</button><div id="scoreStatus" class="scoreStatus"></div></div>
  <h2>My comparison gallery</h2><div id="gallery" class="gallery"><div class="empty">Generated combinations will appear here.</div></div>
</section></main>
<dialog id="zoom"><button id="closeZoom">Close</button><img id="zoomImage"></dialog>
<script>
const $=s=>document.querySelector(s), state={options:null,cards:JSON.parse(localStorage.getItem('pong-swap-lab-cards-v1')||'[]'),scores:{},current:null};
function option(select, item){const o=document.createElement('option');o.value=item.id;o.textContent=item.label;select.append(o)}
function setBusy(on,msg){$('#generate').disabled=on;$('#live').classList.toggle('busy',on);$('#live span').textContent=on?'Rendering': 'Ready';$('#status').className='status'+(!on&&msg?' good':'');$('#status').textContent=msg||''}
function save(){localStorage.setItem('pong-swap-lab-cards-v1',JSON.stringify(state.cards))}
function cardKey(c){return [c.face,c.model,c.restorer].join('|')}
function renderGallery(){const g=$('#gallery');g.innerHTML='';if(!state.cards.length){g.innerHTML='<div class="empty">Generated combinations will appear here.</div>';return}for(const c of state.cards){const key=cardKey(c),d=document.createElement('article');d.className='card';const im=document.createElement('img');im.src=c.image;im.alt=c.modelLabel+' + '+c.restorerLabel;im.onclick=()=>{$('#zoomImage').src=c.image;$('#zoom').showModal()};const m=document.createElement('div');m.className='meta';const saved=state.scores[key];m.innerHTML=`<strong>${c.face}</strong><span>${c.modelLabel}<br>${c.restorerLabel}</span>${saved?`<span class="savedScore">Score: ${Number(saved.score).toFixed(1)}/10</span>`:''}`;d.append(im,m);g.append(d)}}
async function init(){const [r,s]=await Promise.all([fetch('/api/options'),fetch('/api/scores')]);state.options=await r.json();state.scores=(await s.json()).latest||{};for(const f of state.options.faces)option($('#face'),f);for(const m of state.options.models)option($('#model'),m);for(const x of state.options.restorers)option($('#restorer'),x);$('#target').src=state.options.target;$('#model').value='inswapper_128_fp16';$('#restorer').value='gpen_bfr_512';updateFace();renderGallery()}
function updateFace(){$('#facePreview').src='/api/face/'+encodeURIComponent($('#face').value)}
$('#face').onchange=updateFace;
$('#generate').onclick=async()=>{setBusy(true,'Generating… first use of a model may take longer.');try{const body={face:$('#face').value,model:$('#model').value,restorer:$('#restorer').value};const r=await fetch('/api/render',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.detail||'Generation failed');state.current=data;$('#result').src=data.image;$('#resultCaption').textContent=data.modelLabel+' + '+data.restorerLabel;const prior=state.scores[cardKey(data)];$('#scoreMeter').value=prior?prior.score:5;$('#scoreValue').textContent=Number($('#scoreMeter').value).toFixed(1);$('#scoreMeter').disabled=false;$('#submitScore').disabled=false;$('#scoreStatus').textContent=prior?'Previously submitted: '+Number(prior.score).toFixed(1)+'/10':'';state.cards=state.cards.filter(c=>cardKey(c)!==cardKey(data));state.cards.unshift(data);state.cards=state.cards.slice(0,60);save();renderGallery();setBusy(false,(data.cached?'Loaded cached result in ':'Generated in ')+(data.elapsedMs/1000).toFixed(1)+'s')}catch(e){setBusy(false,'');$('#status').className='status';$('#status').textContent=e.message}};
$('#scoreMeter').oninput=()=>{$('#scoreValue').textContent=Number($('#scoreMeter').value).toFixed(1)};
$('#submitScore').onclick=async()=>{if(!state.current)return;$('#submitScore').disabled=true;$('#scoreStatus').textContent='Saving…';try{const body={face:state.current.face,model:state.current.model,restorer:state.current.restorer,score:Number($('#scoreMeter').value)};const r=await fetch('/api/scores',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(data.detail||'Score could not be saved');state.scores[cardKey(state.current)]=data.entry;$('#scoreStatus').textContent='Saved '+Number(data.entry.score).toFixed(1)+'/10 for '+data.entry.modelLabel+' + '+data.entry.restorerLabel;renderGallery()}catch(e){$('#scoreStatus').textContent=e.message}finally{$('#submitScore').disabled=false}};
$('#closeZoom').onclick=()=>$('#zoom').close();$('#zoom').onclick=e=>{if(e.target===$('#zoom'))$('#zoom').close()};init().catch(e=>{$('#status').textContent=e.message});
</script></body></html>'''


if __name__ == "__main__":
    import uvicorn

    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    uvicorn.run(app, host="127.0.0.1", port=PORT, access_log=False)
