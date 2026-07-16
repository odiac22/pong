import argparse
import json
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.request import Request, urlopen


STATE = {
    "ready": False,
    "loading": False,
    "error": "",
    "model": "",
    "adapter": "",
    "loadedAt": "",
}
MODEL = None
PROCESSOR = None
DEVICE = None
LOCK = threading.Lock()


def write_status(local_dir: Path, status: str, message: str, **extra):
    local_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "status": status,
        "message": message,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **extra,
    }
    (local_dir / "lora-inference-status.json").write_text(json.dumps(payload, indent=2), encoding="utf-8")


def extract_json_object(text: str):
    raw = (text or "").strip()
    try:
        return json.loads(raw)
    except Exception:
        pass
    match = re.search(r"\{.*\}", raw, flags=re.S)
    if match:
        return json.loads(match.group(0))
    raise ValueError("No JSON object in model output")


def salvage_partial_result(text: str):
    raw = text or ""
    decision_match = re.search(r'"decision"\s*:\s*"(accept|reject|unsure)"', raw, flags=re.I)
    confidence_match = re.search(r'"confidence"\s*:\s*([01](?:\.\d+)?)', raw, flags=re.I)
    reason_match = re.search(r'"reason"\s*:\s*"([^"]{1,140})', raw, flags=re.I)

    if not decision_match:
        raise ValueError("No decision in partial model output")

    checks = {}
    for key in [
        "photograph",
        "woman_prominent",
        "male_only",
        "male_present",
        "female_presenting_adult",
        "appears_over_50",
        "feet_dominant",
        "logo_or_placeholder",
    ]:
        value_match = re.search(rf'"{re.escape(key)}"\s*:\s*(true|false|null)', raw, flags=re.I)
        if value_match:
            token = value_match.group(1).lower()
            checks[key] = None if token == "null" else token == "true"

    return {
        "decision": decision_match.group(1).lower(),
        "confidence": float(confidence_match.group(1)) if confidence_match else 0.6,
        "reason": (reason_match.group(1) if reason_match else "partial lora output").strip(),
        "checks": checks,
    }


def normalize_result(parsed, fallback_reason="qwen lora decision"):
    checks = parsed.get("checks") or {}
    return {
        "decision": parsed.get("decision") if parsed.get("decision") in ["accept", "reject", "unsure"] else "unsure",
        "confidence": max(0, min(1, float(parsed.get("confidence", 0.5) or 0.5))),
        "reason": str(parsed.get("reason") or fallback_reason)[:140],
        "source": "qwen_lora",
        "checks": {
            "photograph": checks.get("photograph"),
            "woman_prominent": checks.get("woman_prominent"),
            "male_only": checks.get("male_only"),
            "male_present": checks.get("male_present"),
            "female_presenting_adult": checks.get("female_presenting_adult"),
            "appears_over_50": checks.get("appears_over_50"),
            "feet_dominant": checks.get("feet_dominant"),
            "logo_or_placeholder": checks.get("logo_or_placeholder"),
        },
    }


def fetch_image(url: str, timeout=20):
    req = Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 PongLoraInference/1.0",
            "Referer": "https://coomerfans.com/",
        },
    )
    with urlopen(req, timeout=timeout) as response:
        data = response.read(12 * 1024 * 1024)
    from PIL import Image
    return Image.open(BytesIO(data)).convert("RGB")


def load_model(repo_root: Path):
    global MODEL, PROCESSOR, DEVICE
    if STATE["ready"] or STATE["loading"]:
        return
    STATE["loading"] = True
    local_dir = repo_root / ".pong-local-ai"
    adapter = local_dir / "qwen-lora" / "latest"
    model_id = os.environ.get("PONG_LORA_BASE_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")

    try:
        import torch
        from peft import PeftModel
        from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration

        if not (adapter / "adapter_model.safetensors").exists():
            raise FileNotFoundError(f"Missing adapter: {adapter}")

        dtype = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else torch.float16
        device_map = "auto" if torch.cuda.is_available() else None
        processor = AutoProcessor.from_pretrained(adapter, trust_remote_code=True)
        base = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_id,
            torch_dtype=dtype,
            device_map=device_map,
            trust_remote_code=True,
        )
        model = PeftModel.from_pretrained(base, adapter)
        model.eval()

        MODEL = model
        PROCESSOR = processor
        DEVICE = next(model.parameters()).device
        STATE.update({
            "ready": True,
            "loading": False,
            "error": "",
            "model": model_id,
            "adapter": str(adapter),
            "loadedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })
        write_status(local_dir, "ready", "Qwen LoRA inference model is ready.", model=model_id, adapter=str(adapter))
    except Exception as exc:
        STATE.update({"ready": False, "loading": False, "error": str(exc)})
        write_status(local_dir, "blocked", f"Qwen LoRA inference failed: {exc}", model=model_id, adapter=str(adapter))


def classify(payload):
    if not STATE["ready"]:
        raise RuntimeError(STATE["error"] or "LoRA model is not ready")

    candidate_urls = list(dict.fromkeys(payload.get("candidateImageUrls") or []))[:3]
    images = []
    for url in candidate_urls:
        try:
            images.append(fetch_image(url))
        except Exception:
            pass
    if not images:
        return normalize_result({"decision": "reject", "confidence": 1, "reason": "no readable candidate images", "checks": {}})

    artist = payload.get("artist") or {}
    siglip = payload.get("siglipDecision") or {}
    image_grades = payload.get("imageGrades") or []
    grade_lines = "\n".join(
        f"image {item.get('image_index')}: {item.get('decision')} confidence {item.get('confidence')} {item.get('reason', '')}"
        for item in image_grades[:5]
    )

    system_text = (
        "You are a strict local LoRA-adapted visual triage classifier. "
        "Return only one compact minified JSON object with keys decision, confidence, reason, checks. "
        "Keep reason under 12 words. "
        "Do not identify anyone. Do not infer ethnicity, sexuality, medical conditions, or weight status. "
        "Use Trans only as a text/URL hard-filter clue supplied by runtime, never as an appearance inference."
    )
    user_text = (
        f"Artist: {artist.get('artistName') or 'unknown'}\n"
        f"URL: {artist.get('artistUrl') or ''}\n"
        f"SigLIP full-bank preference signal: {siglip.get('decision')} confidence {siglip.get('confidence')}, {siglip.get('reason') or ''}\n"
        f"Recent reject reason history: {payload.get('rejectionSummary') or 'none'}\n"
        f"Per-image embedding grades:\n{grade_lines or 'none'}\n\n"
        "Hard visual checks first: reject if any male-presenting person is visible, male-only, no clearly female-presenting adult is visible across the candidate image set, feet are the main subject, non-photo/logo/placeholder/anime/artwork, unclear adult age, or appears over the age limit. "
        "Reject if the whole candidate set lacks enough visible face or body evidence. A face-only or body-only image can still be judged when enough evidence is visible. "
        "After hard checks, use the LoRA-adapted saved preference plus the full-bank embedding signal. "
        'Return JSON only, like {"decision":"reject","confidence":0.98,"reason":"male visible","checks":{"photograph":true,"woman_prominent":false,"male_only":true,"male_present":true,"female_presenting_adult":false,"appears_over_50":null,"feet_dominant":false,"logo_or_placeholder":false}}'
    )

    messages = [
        {"role": "system", "content": [{"type": "text", "text": system_text}]},
        {"role": "user", "content": [{"type": "image", "image": image} for image in images] + [{"type": "text", "text": user_text}]},
    ]

    with LOCK:
        import torch
        text = PROCESSOR.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = PROCESSOR(text=[text], images=images, return_tensors="pt", padding=True)
        inputs = {k: v.to(DEVICE) if hasattr(v, "to") else v for k, v in inputs.items()}
        with torch.no_grad():
            generated = MODEL.generate(
                **inputs,
                max_new_tokens=int(os.environ.get("PONG_LORA_MAX_NEW_TOKENS", "220")),
                do_sample=False,
            )
        output_ids = generated[:, inputs["input_ids"].shape[1]:]
        output = PROCESSOR.batch_decode(output_ids, skip_special_tokens=True)[0]

    try:
        return normalize_result(extract_json_object(output))
    except Exception:
        try:
            parsed = salvage_partial_result(output)
            parsed["reason"] = f"{parsed.get('reason', 'partial lora output')} (partial)"
            return normalize_result(parsed)
        except Exception:
            return normalize_result({
                "decision": "unsure",
                "confidence": 0.5,
                "reason": f"could not parse lora output: {output[:90]}",
                "checks": {},
            })


class Handler(BaseHTTPRequestHandler):
    repo_root: Path = Path(".")

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_):
        return

    def do_OPTIONS(self):
        self._json(204, {})

    def do_GET(self):
        if self.path.startswith("/health"):
            self._json(200, {"ok": True, **STATE})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/classify":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            self._json(200, classify(payload))
        except Exception as exc:
            self._json(500, {"error": str(exc), "ok": False, **STATE})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=os.environ.get("PONG_REPO_ROOT", "."))
    parser.add_argument("--host", default=os.environ.get("PONG_LORA_INFERENCE_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PONG_LORA_INFERENCE_PORT", "8790")))
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    Handler.repo_root = repo_root
    # Load synchronously. On Windows, loading Qwen/PyTorch in a daemon thread can
    # exit the process without a useful traceback after the HTTP listener opens.
    load_model(repo_root)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Pong LoRA inference listening on http://{args.host}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
