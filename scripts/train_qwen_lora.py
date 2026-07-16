import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path


def write_status(local_dir: Path, status: str, message: str, **extra):
    local_dir.mkdir(parents=True, exist_ok=True)
    payload = {
        "status": status,
        "message": message,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        **extra,
    }
    (local_dir / "finetune-status.json").write_text(
        json.dumps(payload, indent=2),
        encoding="utf-8",
    )


def load_jsonl(path: Path):
    if not path.exists():
        return []
    rows = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line:
            rows.append(json.loads(line))
    return rows


def iter_image_samples(rows, local_dir: Path):
    for row in rows:
        label = row.get("label", "")
        reason = f"{row.get('rejectReasonLabel') or row.get('rejectReason') or ''}".strip()
        # Keep user text/URL Trans hard filters out of image fine-tuning. The
        # runtime hard filter still blocks them from text/URL evidence.
        if label == "reject" and "trans" in reason.lower():
            continue

        for image in row.get("images", []):
            rel = image.get("path", "")
            if not rel:
                continue
            image_path = local_dir / rel
            if image_path.exists():
                yield row, image_path


def target_answer(row):
    label = row.get("label", "")
    reason = row.get("rejectReasonLabel") or row.get("rejectReason") or ""
    return json.dumps({
        "decision": "accept" if label == "accept" else "reject",
        "confidence": 1,
        "reason": "user saved accepted artist" if label == "accept" else f"user red-X rejected artist{(': ' + reason) if reason else ''}",
    })


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", default=os.environ.get("PONG_REPO_ROOT", "."))
    args = parser.parse_args()

    repo_root = Path(args.repo_root).resolve()
    local_dir = repo_root / ".pong-local-ai"
    jsonl_path = local_dir / "qwen-lora-dataset.jsonl"
    rows = load_jsonl(jsonl_path)

    if not rows:
        write_status(local_dir, "no_data", "No LoRA rows are available yet.")
        return 0

    try:
        import torch
        from PIL import Image
        from peft import LoraConfig, PeftModel, get_peft_model
        from transformers import AutoProcessor, Qwen2_5_VLForConditionalGeneration
    except Exception as exc:
        write_status(
            local_dir,
            "blocked",
            f"LoRA dependencies are missing: {exc}",
            datasetRows=len(rows),
        )
        return 20

    samples = list(iter_image_samples(rows, local_dir))
    if not samples:
        write_status(local_dir, "no_data", "No image samples are available for LoRA training.", datasetRows=len(rows))
        return 0

    model_id = os.environ.get("PONG_LORA_BASE_MODEL", "Qwen/Qwen2.5-VL-3B-Instruct")
    max_steps = int(os.environ.get("PONG_LORA_MAX_STEPS", "24"))
    learning_rate = float(os.environ.get("PONG_LORA_LR", "1e-4"))
    adapter_dir = local_dir / "qwen-lora"
    latest_dir = adapter_dir / "latest"
    run_dir = adapter_dir / time.strftime("run-%Y%m%d-%H%M%S", time.gmtime())

    write_status(
        local_dir,
        "running",
        f"Loading {model_id} for LoRA training.",
        datasetRows=len(rows),
        samples=len(samples),
        model=model_id,
    )

    dtype = torch.bfloat16 if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else torch.float16
    device_map = "auto" if torch.cuda.is_available() else None

    try:
        processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        model = Qwen2_5_VLForConditionalGeneration.from_pretrained(
            model_id,
            torch_dtype=dtype,
            device_map=device_map,
            trust_remote_code=True,
        )
    except Exception as exc:
        write_status(local_dir, "blocked", f"Could not load base model: {exc}", model=model_id)
        return 21

    try:
        model.gradient_checkpointing_enable()
    except Exception:
        pass

    if latest_dir.exists():
        try:
            model = PeftModel.from_pretrained(model, latest_dir, is_trainable=True)
        except Exception:
            pass

    if not hasattr(model, "peft_config"):
        config = LoraConfig(
            r=int(os.environ.get("PONG_LORA_R", "8")),
            lora_alpha=int(os.environ.get("PONG_LORA_ALPHA", "16")),
            lora_dropout=float(os.environ.get("PONG_LORA_DROPOUT", "0.05")),
            target_modules=["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"],
            task_type="CAUSAL_LM",
        )
        model = get_peft_model(model, config)

    model.train()
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad), lr=learning_rate)
    device = next(model.parameters()).device

    write_status(local_dir, "running", "Training Qwen LoRA adapter.", samples=len(samples), maxSteps=max_steps, model=model_id)

    step = 0
    total_loss = 0.0
    while step < max_steps:
      for row, image_path in samples:
        if step >= max_steps:
            break

        try:
            image = Image.open(image_path).convert("RGB")
        except Exception:
            continue

        prompt = (
            "Classify this Random 40 training image using the user's saved preference. "
            "Follow hard filters first. Do not infer sensitive status from appearance. "
            "Return compact JSON only."
        )
        messages = [{
            "role": "user",
            "content": [
                {"type": "image", "image": image},
                {"type": "text", "text": prompt},
            ],
        }]

        prompt_text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        answer = target_answer(row)
        full_text = prompt_text + answer

        inputs = processor(text=[full_text], images=[image], return_tensors="pt", padding=True)
        inputs = {k: v.to(device) if hasattr(v, "to") else v for k, v in inputs.items()}
        labels = inputs["input_ids"].clone()

        optimizer.zero_grad(set_to_none=True)
        outputs = model(**inputs, labels=labels)
        loss = outputs.loss
        loss.backward()
        optimizer.step()

        total_loss += float(loss.detach().cpu())
        step += 1

    run_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(run_dir)
    processor.save_pretrained(run_dir)

    if latest_dir.exists():
        shutil.rmtree(latest_dir)
    shutil.copytree(run_dir, latest_dir)

    avg_loss = total_loss / max(step, 1)
    write_status(
        local_dir,
        "complete",
        "Qwen LoRA adapter trained.",
        model=model_id,
        steps=step,
        averageLoss=avg_loss,
        adapterPath=str(latest_dir),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
