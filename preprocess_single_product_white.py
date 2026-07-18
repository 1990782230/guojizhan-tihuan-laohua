from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


API_PROJECT = Path(r"D:\国际站\bag_pattern_pipeline")
API_CONFIG = API_PROJECT / "config" / "api_config.json"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}

PROMPT = """图1是待整理的产品照片。
只保留画面中面积最大、最靠前的一个完整包袋，作为唯一商品。
移除其他包袋、包装盒、包装袋、展台、纸张、文字、吊牌、保护套、手、手套及所有背景杂物。
只保留该包袋本体和固定连接的手柄、肩带、五金；移除可拆吊牌和包装附件。
将商品完整居中放置在纯白 RGB(255,255,255) 无缝背景上，保留柔和自然的接触阴影。
严格保持商品原有包型、比例、视角、颜色、材质、纹样形状、纹样数量、纹样位置、纹样配色、缝线和五金，不重新设计或增删纹样。
输出正方形电商白底单品图，不添加文字、水印或其他物品。"""


def api_client():
    sys.path.insert(0, str(API_PROJECT))
    from api_client import ImageApiClient

    return ImageApiClient(API_CONFIG)


def process_one(source: Path, output_dir: Path) -> dict[str, object]:
    started = time.perf_counter()
    output = output_dir / f"{source.stem}.png"
    try:
        meta = api_client().edit_images(
            [source],
            PROMPT,
            output,
            model="gpt-image-2",
            size="1024x1024",
            quality="high",
            input_fidelity="high",
        )
        return {
            "source": str(source),
            "output": str(output),
            "ok": True,
            "seconds": round(time.perf_counter() - started, 3),
            "api": meta,
        }
    except Exception as exc:
        return {
            "source": str(source),
            "output": str(output),
            "ok": False,
            "seconds": round(time.perf_counter() - started, 3),
            "error": f"{type(exc).__name__}: {exc}",
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-dir", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=5)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    sources = sorted(
        path
        for path in args.input_dir.iterdir()
        if path.is_file() and path.suffix.lower() in IMAGE_SUFFIXES
    )
    started = time.perf_counter()
    results: list[dict[str, object]] = []
    with ThreadPoolExecutor(max_workers=max(1, args.workers)) as executor:
        futures = {
            executor.submit(process_one, source, args.output_dir): source
            for source in sources
        }
        for future in as_completed(futures):
            result = future.result()
            results.append(result)
            print(
                f"[white] {Path(str(result['source'])).name}: "
                f"ok={result['ok']} {result['seconds']}s",
                flush=True,
            )
    report = {
        "input_dir": str(args.input_dir),
        "output_dir": str(args.output_dir),
        "workers": args.workers,
        "prompt": PROMPT,
        "source_count": len(sources),
        "completed_count": sum(bool(item["ok"]) for item in results),
        "total_seconds": round(time.perf_counter() - started, 3),
        "results": sorted(results, key=lambda item: str(item["source"])),
    }
    (args.output_dir / "preprocess_report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
