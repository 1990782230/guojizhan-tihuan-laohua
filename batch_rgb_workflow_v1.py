from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg"}
STAGES = ("label", "build", "clean", "final")


def run_stage(
    workflow: Path, source: Path, output: Path, stage: str
) -> dict[str, object]:
    started = time.perf_counter()
    command = [
        sys.executable,
        str(workflow),
        "--input",
        str(source),
        "--output",
        str(output),
        "--stage",
        stage,
    ]
    process = subprocess.run(
        command,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    log = output / f"{stage}.log"
    output.mkdir(parents=True, exist_ok=True)
    log.write_text(
        process.stdout + ("\n--- STDERR ---\n" + process.stderr if process.stderr else ""),
        encoding="utf-8",
    )
    return {
        "source": str(source),
        "output": str(output),
        "stage": stage,
        "returncode": process.returncode,
        "seconds": round(time.perf_counter() - started, 3),
        "log": str(log),
        "error": process.stderr[-2000:] if process.returncode else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output-root", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=5)
    parser.add_argument(
        "--workflow",
        type=Path,
        default=Path(r"D:\ai\包包处理\rgb_workflow_v1.py"),
    )
    args = parser.parse_args()
    args.output_root.mkdir(parents=True, exist_ok=True)
    sources = sorted(
        path
        for path in args.input_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )
    tasks = [(source, args.output_root / source.stem) for source in sources]
    batch_started = time.perf_counter()
    results: list[dict[str, object]] = []
    active = tasks

    for stage in STAGES:
        stage_results: list[dict[str, object]] = []
        with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
            futures = {
                executor.submit(
                    run_stage, args.workflow, source, output, stage
                ): (source, output)
                for source, output in active
            }
            for future in as_completed(futures):
                result = future.result()
                stage_results.append(result)
                print(
                    f"[{stage}] {Path(str(result['source'])).name}: "
                    f"rc={result['returncode']} {result['seconds']}s",
                    flush=True,
                )
        results.extend(stage_results)
        failed_outputs = {
            str(result["output"])
            for result in stage_results
            if int(result["returncode"]) != 0
        }
        active = [
            (source, output)
            for source, output in active
            if str(output) not in failed_outputs
        ]

    summary = {
        "input_dir": str(args.input_dir),
        "output_root": str(args.output_root),
        "workers": args.workers,
        "source_count": len(sources),
        "completed_count": sum(
            (output / "07_final_ai.png").exists() for _, output in tasks
        ),
        "total_seconds": round(time.perf_counter() - batch_started, 3),
        "results": results,
    }
    (args.output_root / "batch_run_report.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
