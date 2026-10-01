"""Fail-closed contracts for GPEN native-plan qualification certificates."""

from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parent
RUNTIME_PATH = ROOT / "engine" / "Rope" / "rope" / "gpen_runtime.py"
SPEC = importlib.util.spec_from_file_location("gpen_qualification_runtime", RUNTIME_PATH)
runtime_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime_module)
GPENRuntime = runtime_module.GPENRuntime


KINDS = ("ramp", "checker", "bars", "noise", "impulse", "constant")
GATES = {
    "mae": 0.10,
    "p99Abs": 1.0,
    "maxAbs": 4.0,
    "psnrDb": 50.0,
    "ssim": 0.999,
    "temporalMae": 0.20,
}


class Owner:
    pass


class QualifiedPlanValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.owner = Owner()
        self.plan = self.root / "qualified.plan"
        self.plan.write_bytes(b"synthetic immutable TensorRT plan")
        self.plan_hash = hashlib.sha256(self.plan.read_bytes()).hexdigest()
        self.trusted_plan_patch = mock.patch.object(
            runtime_module,
            "TRUSTED_EXTERNAL_GPEN_PLAN_SHA256",
            frozenset({self.plan_hash}),
        )
        self.trusted_plan_patch.start()
        self.report_path = self.root / "report.json"
        self.owner._gpen_native_trt_qualified_plan = str(self.plan)
        torch = SimpleNamespace(
            version=SimpleNamespace(cuda="synthetic-cuda"),
            cuda=SimpleNamespace(
                get_device_name=lambda _index: "synthetic-gpu",
                get_device_capability=lambda _index: (8, 9),
            ),
        )
        self.runtime = GPENRuntime(
            self.owner,
            torch,
            SimpleNamespace(__version__="synthetic-ort"),
            "float32",
        )
        self.trt = SimpleNamespace(__version__="synthetic-trt")
        self.identity = {
            "modelSha256": "a" * 64,
            "workspaceBytes": 1 << 30,
        }
        self.build = {
            "torgbPlugin": False,
            "fp16": False,
            "tf32": True,
            "int8": False,
            "workspaceBytes": 4 << 30,
            "builderOptimizationLevel": 5,
            "buildRecipeVersion": "strict-fp32-builder-v2",
            "externalPlan": False,
        }

    def tearDown(self) -> None:
        self.trusted_plan_patch.stop()
        self.temporary.cleanup()

    def fixtures(self) -> list[dict]:
        result = []
        for kind in KINDS:
            for step in (0, 1):
                item = {
                    "kind": kind,
                    "step": step,
                    "mae": 0.01,
                    "p99Abs": 0.05,
                    "maxAbs": 0.2,
                    "psnrDb": 75.0,
                    "ssim": 0.99999,
                    "pass": True,
                }
                if step:
                    item.update(temporalMae=0.02, temporalPass=True)
                result.append(item)
        return result

    def publish(self, mutate=None) -> None:
        plan_hash = hashlib.sha256(self.plan.read_bytes()).hexdigest()
        report = {
            "status": "pass",
            "qualityPass": True,
            "planSha256": plan_hash,
            "identity": {
                "qualityGateVersion": "generated-gpen-v1",
                "buildRecipeVersion": "strict-fp32-builder-v2",
                "modelSha256": self.identity["modelSha256"],
                "tensorrt": self.trt.__version__,
                "cuda": "synthetic-cuda",
                "gpu": "synthetic-gpu",
                "capability": [8, 9],
                "fp16": False,
                "tf32": True,
                "int8": False,
                "workspaceBytes": 4 << 30,
                "builderOptimizationLevel": 5,
                "strictMath": False,
                "tacticProfile": "default",
                "torgbPlugin": False,
            },
            "build": self.build,
            "qualityGates": GATES,
            "fixtures": self.fixtures(),
            "reference": {"count": 64, "p50Ms": 60.0},
            "candidate": {"count": 64, "p50Ms": 27.0},
        }
        manifest = {
            "schema": "pong-gpen-qualified-plan-v2",
            "qualificationStatus": "pass",
            "qualityGateVersion": "generated-gpen-v1",
            "buildRecipeVersion": "strict-fp32-builder-v2",
            "modelSha256": self.identity["modelSha256"],
            "edge": 512,
            "tensorrt": self.trt.__version__,
            "cuda": "synthetic-cuda",
            "gpu": "synthetic-gpu",
            "capability": [8, 9],
            "fp16": False,
            "tf32": True,
            "int8": False,
            "strictMath": False,
            "precisionPolicy": "fp32-builder-default-v1",
            "tacticProfile": "default",
            "builderOptimizationLevel": 5,
            "workspaceBytes": 4 << 30,
            "build": self.build,
            "planSha256": plan_hash,
            "plan": str(self.plan.resolve()),
            "report": str(self.report_path.resolve()),
        }
        if mutate is not None:
            mutate(report, manifest)
        report_bytes = json.dumps(report, allow_nan=False).encode("utf-8")
        self.report_path.write_bytes(report_bytes)
        manifest["reportSha256"] = hashlib.sha256(report_bytes).hexdigest()
        Path(str(self.plan) + ".manifest.json").write_text(
            json.dumps(manifest, allow_nan=False),
            encoding="utf-8",
        )

    def validate(self):
        return self.runtime._qualified_native_plan(
            512,
            self.trt,
            self.identity,
        )

    def adopted_external_mutation(self):
        plan_hash = hashlib.sha256(self.plan.read_bytes()).hexdigest()
        plan_value = str(self.plan.resolve())
        warm = {
            "restorers": {
                "512": {
                    "nativePlanSha256": plan_hash,
                    "nativePlanQualified": True,
                    "effectiveBackend": "native-trt",
                }
            }
        }
        strict_path = self.root / "strict.json"
        strict_path.write_text(json.dumps({
            "schema": "pong-temporal-attachment-v1",
            "configuration": {"runtime": {"restorerNativeTrtQualifiedPlan": plan_value}},
            "warm": warm,
            "promotionGate": {"passed": True, "expectedPlanSha256": plan_hash},
            "summary": {"noErrors": True, "allSilent": True},
            "clips": [
                {
                    "checks": {"identityProof": True, "noError": True},
                    "quality": {"occlusionCoreSampleCount": 1},
                },
                {
                    "checks": {"identityProof": True, "noError": True},
                    "quality": {},
                },
                {
                    "checks": {"identityProof": True, "noError": True},
                    "quality": {},
                },
            ],
        }), encoding="utf-8")
        holdout_path = self.root / "holdout.json"
        holdout_path.write_text(json.dumps({
            "schema": "pong-realtime-corpus-v1",
            "configuration": {"runtime": {"restorerNativeTrtQualifiedPlan": plan_value}},
            "warm": warm,
            "summary": {
                "allClipsPassed": True,
                "distinctEligibleClipCount": 20,
                "failedClips": 0,
            },
        }), encoding="utf-8")
        adoption = {
            "schema": "pong-gpen-external-plan-adoption-v1",
            "planSha256": plan_hash,
            "planBytes": self.plan.stat().st_size,
            "engineBytesModified": False,
            "originalReportSha256": "b" * 64,
            "originalManifestSha256": "c" * 64,
            "evidence": {
                "strictTemporal": {
                    "path": str(strict_path.resolve()),
                    "sha256": hashlib.sha256(strict_path.read_bytes()).hexdigest(),
                },
                "holdoutCorpus": {
                    "path": str(holdout_path.resolve()),
                    "sha256": hashlib.sha256(holdout_path.read_bytes()).hexdigest(),
                },
            },
        }

        def mutate(report, manifest):
            report["build"]["externalPlan"] = True
            manifest["build"]["externalPlan"] = True
            report["externalPlanAdoption"] = adoption
            manifest["externalPlanAdoption"] = adoption

        return mutate, strict_path

    def test_complete_certificate_passes(self) -> None:
        self.publish()
        self.assertEqual(self.validate()["sha256"], hashlib.sha256(
            self.plan.read_bytes()
        ).hexdigest())

    def test_non_object_fixture_fails(self) -> None:
        self.publish(lambda report, _manifest: report["fixtures"].__setitem__(0, None))
        with self.assertRaisesRegex(RuntimeError, "fixtureValidation"):
            self.validate()

    def test_missing_explicit_temporal_pass_fails(self) -> None:
        def mutate(report, _manifest):
            report["fixtures"][1].pop("temporalPass")
        self.publish(mutate)
        with self.assertRaisesRegex(RuntimeError, "fixtureValidation"):
            self.validate()

    def test_duplicate_fixture_cannot_replace_required_coverage(self) -> None:
        def mutate(report, _manifest):
            report["fixtures"][1] = dict(report["fixtures"][0])
        self.publish(mutate)
        with self.assertRaisesRegex(RuntimeError, "fixtureValidation"):
            self.validate()

    def test_external_plan_provenance_is_rejected(self) -> None:
        def mutate(report, manifest):
            report["build"]["externalPlan"] = True
            manifest["build"]["externalPlan"] = True
        self.publish(mutate)
        with self.assertRaisesRegex(RuntimeError, "externalPlan"):
            self.validate()

    def test_missing_external_plan_provenance_is_rejected(self) -> None:
        def mutate(report, manifest):
            report["build"].pop("externalPlan")
            manifest["build"].pop("externalPlan", None)
        self.publish(mutate)
        with self.assertRaisesRegex(RuntimeError, "externalPlan"):
            self.validate()

    def test_evidence_bound_external_plan_passes(self) -> None:
        mutate, _strict_path = self.adopted_external_mutation()
        self.publish(mutate)
        self.assertEqual(
            self.validate()["sha256"],
            hashlib.sha256(self.plan.read_bytes()).hexdigest(),
        )

    def test_adopted_external_plan_rejects_changed_evidence(self) -> None:
        mutate, strict_path = self.adopted_external_mutation()
        self.publish(mutate)
        strict_path.write_text("{}", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "externalPlanAdoption"):
            self.validate()

    def test_adopted_external_plan_requires_release_authorization(self) -> None:
        mutate, _strict_path = self.adopted_external_mutation()
        self.publish(mutate)
        with mock.patch.object(
            runtime_module,
            "TRUSTED_EXTERNAL_GPEN_PLAN_SHA256",
            frozenset(),
        ):
            with self.assertRaisesRegex(RuntimeError, "trusted local release registry"):
                self.validate()

    def test_pass_flags_cannot_override_numerical_gate_failures(self) -> None:
        mutations = {
            "mae": lambda item: item.update(mae=999.0),
            "temporalMae": lambda item: item.update(temporalMae=999.0),
            "ssim": lambda item: item.update(ssim=-10.0),
            "psnrDb": lambda item: item.update(psnrDb=-10.0),
        }
        for name, change in mutations.items():
            with self.subTest(metric=name):
                def mutate(report, _manifest, *, change=change, name=name):
                    change(report["fixtures"][1 if name == "temporalMae" else 0])
                self.publish(mutate)
                with self.assertRaisesRegex(RuntimeError, "fixtureValidation"):
                    self.validate()


if __name__ == "__main__":
    unittest.main()
