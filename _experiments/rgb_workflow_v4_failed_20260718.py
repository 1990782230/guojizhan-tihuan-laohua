from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np
from PIL import Image


API_PROJECT = Path(r"D:\国际站\bag_pattern_pipeline")
API_CONFIG = API_PROJECT / "config" / "api_config.json"
ELEMENT_DIR = Path(r"D:\国际站\work\bag_pattern_test\elements")

ELEMENTS = {
    "letter": ELEMENT_DIR / "element_letter.png",
    "diamond": ELEMENT_DIR / "element_diamond.png",
    "round": ELEMENT_DIR / "element_round.png",
    "A": ELEMENT_DIR / "element_A.png",
    "B": ELEMENT_DIR / "element_B.png",
}

LABEL_PROMPT = """Edit the provided handbag image into a flat pure-RGB semantic label map, preserving the original composition, alignment, object boundaries, and visible extents exactly. Output only solid flat colors with no texture, no shading, no gradients, no text, no outlines, no shadows, and no anti-aliased styling.

Color mapping:
- Blue RGB(0,0,255): the entire visible main bag body panels that are the replacement-pattern slot areas.
- Red RGB(255,0,0): the original letter-combination monogram pattern.
- Purple RGB(255,0,255): the original diamond and four-point star main pattern elements.
- Orange RGB(255,128,0): the original circular or medallion patterns.
- Green RGB(0,255,0): only independent compact repeated small four-petal or secondary motif patterns.
- Black RGB(0,0,0): everything else, including white background, handles, straps, zippers, metal hardware, trim, corners, and hang tags.

Important constraints:
- Continuous straight lines, diagonal lines, grid lines, connecting lines, decorative lines, embossing lines, topstitching, and seams on the bag body are NOT pattern slots; they must be labeled blue as part of the bag body.
- Short or separated stitch dashes that align into a longer straight, diagonal, curved, lattice, or quilted line are still structural lines. Label every one of those dashes blue, never green.
- Green is reserved for a complete compact motif with its own closed recognizable outline. Do not label fragments of stitching, line intersections, leather grain, or embossed line segments green.
- Pattern colors must overwrite blue bag-body color only where true motifs exist.
- Do not omit true motifs because the bag is not brown; keep all true motif centers, sizes, crop boundaries, and visible extents matching the source image.
- Keep the handbag, straps, chain, hardware, and background in their exact positions and silhouettes, but label them black.
- If an element is ambiguous between a motif and part of a line, label it blue.

Create a clean semantic segmentation label image using only the exact RGB colors specified."""

CLEAN_PROMPT = """图1是产品原图。
只清除蒙版内原有纹样，恢复连续自然的无纹样包身表面。
包身原有的连续直线、斜线、格纹、连接线、装饰线、压线和缝线必须完整保留，不属于需要清除的纹样。
保持原包身颜色、材质颗粒、光照、曲率和磨损。
不要增加任何纹样，保持产品结构、手柄、五金、包边、背景和构图不变。"""

FINAL_PROMPT = """图1是无纹样的产品底图，图2是已经完成新纹样排列的目标效果图。
请以图1为基础，将图2中的新纹样自然融合到包身表面。
保持图2的纹样种类、数量、位置、排列和颜色，不要改变纹样配色。
保持图1包身原有的连续线条、格纹、连接线、压线和缝线，不得清除、覆盖或重新设计这些线条。
让纹样自然继承包身的材质颗粒、光照、曲面变化、磨损和印刷质感。
保持包型、手柄、五金、包边、背景和构图不变。"""


def request_size_for(image_path: Path) -> str:
    """Use the closest supported non-square canvas for the source orientation."""
    with Image.open(image_path) as image:
        width, height = image.size
    if width > height:
        return "1536x1024"
    if height > width:
        return "1024x1536"
    return "1024x1024"


def normalize_output_size(path: Path, target_size: tuple[int, int]) -> None:
    """Keep every stage file at the original photo dimensions/aspect ratio."""
    image = Image.open(path).convert("RGB")
    if image.size != target_size:
        image = image.resize(target_size, Image.Resampling.LANCZOS)
        image.save(path)


def api_client():
    sys.path.insert(0, str(API_PROJECT))
    from api_client import ImageApiClient

    return ImageApiClient(API_CONFIG)


def read_cv(path: Path, flag: int = cv2.IMREAD_COLOR) -> np.ndarray:
    return cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), flag)


def write_cv(path: Path, image: np.ndarray) -> None:
    cv2.imencode(path.suffix, image)[1].tofile(str(path))


def rgba_edit_mask(editable: np.ndarray, output: Path) -> None:
    rgba = np.full((*editable.shape, 4), 255, dtype=np.uint8)
    rgba[:, :, 3] = np.where(editable > 0, 0, 255).astype(np.uint8)
    Image.fromarray(rgba, "RGBA").save(output)


def decode(rgb: np.ndarray) -> dict[str, np.ndarray]:
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    return {
        "panel": ((b > 145) & (r < 130) & (g < 155)).astype(np.uint8) * 255,
        "letter": ((r > 155) & (g < 125) & (b < 130)).astype(np.uint8) * 255,
        "diamond": ((r > 145) & (b > 140) & (g < 145)).astype(np.uint8) * 255,
        "round": ((r > 150) & (g > 35) & (g < 215) & (b < 135)).astype(np.uint8) * 255,
        "secondary": ((g > 145) & (r < 145) & (b < 145)).astype(np.uint8) * 255,
    }


def white_background_foreground_mask(source_rgb: np.ndarray) -> np.ndarray | None:
    """Return a product foreground mask only when the image has a white border."""

    height, width = source_rgb.shape[:2]
    edge = max(2, int(round(min(height, width) * 0.025)))
    border = np.concatenate(
        [
            source_rgb[:edge].reshape(-1, 3),
            source_rgb[-edge:].reshape(-1, 3),
            source_rgb[:, :edge].reshape(-1, 3),
            source_rgb[:, -edge:].reshape(-1, 3),
        ],
        axis=0,
    )
    border_median = np.median(border, axis=0)
    if float(border_median.min()) < 246.0:
        return None
    distance_from_white = np.max(
        255 - source_rgb.astype(np.int16), axis=2
    )
    chroma = (
        source_rgb.max(axis=2).astype(np.int16)
        - source_rgb.min(axis=2).astype(np.int16)
    )
    intensity = source_rgb.mean(axis=2)
    # Reject soft neutral contact shadows while retaining coloured/light bags
    # and genuinely dark product surfaces.
    foreground = (
        (distance_from_white > 7)
        & ((chroma > 3) | (intensity < 180))
    ).astype(np.uint8) * 255
    foreground = cv2.morphologyEx(
        foreground, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)
    )
    vertical_size = max(9, int(round(min(height, width) * 0.015)))
    if vertical_size % 2 == 0:
        vertical_size += 1
    foreground = cv2.morphologyEx(
        foreground,
        cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, vertical_size)),
    )
    foreground = cv2.dilate(foreground, np.ones((3, 3), np.uint8))
    return foreground


def refine_panel_bottom_on_white(
    source_rgb: np.ndarray, panel: np.ndarray
) -> np.ndarray:
    """Snap the generated panel's lower edge to the real product silhouette."""

    height, width = panel.shape
    vertical_gradient = np.linalg.norm(
        np.diff(source_rgb.astype(np.float32), axis=0), axis=2
    )
    detected = np.full(width, -1, dtype=np.int32)
    active_columns = np.where((panel > 0).any(axis=0))[0]
    search_depth = max(28, int(round(height * 0.075)))
    for x in active_columns:
        ys = np.where(panel[:, x] > 0)[0]
        if len(ys) == 0:
            continue
        label_bottom = int(ys.max())
        start = max(int(ys.min()), label_bottom - search_depth)
        end = min(height - 2, label_bottom + 5)
        if end <= start:
            continue
        scores = vertical_gradient[start : end + 1, x]
        best_offset = int(np.argmax(scores))
        if float(scores[best_offset]) >= 4.0:
            detected[x] = start + best_offset
    smoothed = detected.copy()
    radius = max(5, int(round(width * 0.012)))
    for x in active_columns:
        left, right = max(0, x - radius), min(width, x + radius + 1)
        values = detected[left:right]
        values = values[values >= 0]
        if len(values) >= 3:
            smoothed[x] = int(np.median(values))
    refined = panel.copy()
    for x in active_columns:
        if smoothed[x] >= 0:
            refined[smoothed[x] + 2 :, x] = 0
    return refined


def clean_class_mask(mask: np.ndarray, class_name: str) -> np.ndarray:
    size = {"letter": 5, "diamond": 9, "round": 7, "secondary": 5}[class_name]
    result = cv2.morphologyEx(
        mask, cv2.MORPH_CLOSE, np.ones((size, size), np.uint8)
    )
    result = cv2.morphologyEx(
        result, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8)
    )
    return result


def split_secondary_lines(mask: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Separate continuous/elongated decoration lines from motif components."""

    rejected = np.zeros_like(mask)
    protected_compact_motifs = np.zeros_like(mask)
    raw_count, raw_labels, raw_stats, _ = cv2.connectedComponentsWithStats(mask, 8)
    for index in range(1, raw_count):
        width = int(raw_stats[index, cv2.CC_STAT_WIDTH])
        height = int(raw_stats[index, cv2.CC_STAT_HEIGHT])
        area = int(raw_stats[index, cv2.CC_STAT_AREA])
        bbox_area = max(1, width * height)
        fill_ratio = area / bbox_area
        aspect = max(width, height) / max(1, min(width, height))
        component = np.where(raw_labels == index, 255, 0).astype(np.uint8)
        contours, _ = cv2.findContours(
            component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        oriented_aspect = aspect
        if contours:
            rect_width, rect_height = cv2.minAreaRect(
                max(contours, key=cv2.contourArea)
            )[1]
            oriented_aspect = max(rect_width, rect_height) / max(
                1.0, min(rect_width, rect_height)
            )
        # A complete four-petal/compact motif can contain long internal axes
        # that trigger Hough lines. Protect the whole compact component before
        # line extraction; short stitch dashes remain too small or elongated
        # to enter this protection mask.
        if (
            area >= 90
            and min(width, height) >= 14
            and max(aspect, oriented_aspect) <= 1.9
            and fill_ratio >= 0.18
        ):
            protected_compact_motifs[raw_labels == index] = 255
        if (
            area >= 12
            and max(aspect, oriented_aspect) >= 2.7
            and max(width, height) >= 18
        ):
            rejected[raw_labels == index] = 255

    # A line network can be connected to every small flower, becoming one
    # large component. Detect its long straight segments first, before normal
    # connected-component filtering.
    hough_input = cv2.bitwise_and(mask, cv2.bitwise_not(rejected))
    hough_lines = cv2.HoughLinesP(
        hough_input,
        1,
        np.pi / 180,
        threshold=max(16, int(round(min(mask.shape) * 0.015))),
        minLineLength=max(24, int(round(min(mask.shape) * 0.035))),
        maxLineGap=max(6, int(round(min(mask.shape) * 0.012))),
    )
    if hough_lines is not None:
        line_canvas = np.zeros_like(mask)
        thickness = max(3, int(round(min(mask.shape) * 0.005)))
        for line in hough_lines[:, 0]:
            x1, y1, x2, y2 = (int(value) for value in line)
            cv2.line(
                line_canvas, (x1, y1), (x2, y2), 255, thickness, cv2.LINE_8
            )
        rejected = cv2.bitwise_or(
            rejected,
            cv2.bitwise_and(
                mask,
                cv2.dilate(line_canvas, np.ones((3, 3), np.uint8)),
            ),
        )
    rejected = cv2.bitwise_and(
        rejected, cv2.bitwise_not(protected_compact_motifs)
    )
    # At line intersections a compact flower can be connected to the line.
    # Protect thick compact cores so only the thin arms are preserved.
    blob_size = max(7, int(round(min(mask.shape) * 0.007)))
    if blob_size % 2 == 0:
        blob_size += 1
    blob_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (blob_size, blob_size)
    )
    blob_core = cv2.erode(mask, blob_kernel)
    blob_regions = cv2.dilate(blob_core, blob_kernel)
    rejected = cv2.bitwise_and(rejected, cv2.bitwise_not(blob_regions))
    residual = cv2.bitwise_and(mask, cv2.bitwise_not(rejected))
    residual = cv2.morphologyEx(
        residual, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)
    )

    count, labels, stats, _ = cv2.connectedComponentsWithStats(residual, 8)
    kept = np.zeros_like(mask)
    candidates = [
        index
        for index in range(1, count)
        if int(stats[index, cv2.CC_STAT_AREA]) >= 12
    ]
    if not candidates:
        return mask, rejected
    bbox_areas = np.asarray(
        [
            int(stats[index, cv2.CC_STAT_WIDTH])
            * int(stats[index, cv2.CC_STAT_HEIGHT])
            for index in candidates
        ],
        dtype=np.float32,
    )
    median_bbox_area = max(1.0, float(np.median(bbox_areas)))
    for index in candidates:
        width = int(stats[index, cv2.CC_STAT_WIDTH])
        height = int(stats[index, cv2.CC_STAT_HEIGHT])
        area = int(stats[index, cv2.CC_STAT_AREA])
        bbox_area = max(1, width * height)
        aspect = max(width, height) / max(1, min(width, height))
        fill_ratio = area / bbox_area
        component = np.where(labels == index, 255, 0).astype(np.uint8)
        protected_overlap = int(
            np.logical_and(
                component > 0, protected_compact_motifs > 0
            ).sum()
        )
        contours, _ = cv2.findContours(
            component, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE
        )
        oriented_aspect = aspect
        if contours:
            rect_width, rect_height = cv2.minAreaRect(
                max(contours, key=cv2.contourArea)
            )[1]
            oriented_aspect = max(rect_width, rect_height) / max(
                1.0, min(rect_width, rect_height)
            )
        line_like = protected_overlap < max(8, int(round(area * 0.35))) and (
            (max(aspect, oriented_aspect) >= 2.7 and max(width, height) >= 18)
            or (
                bbox_area >= median_bbox_area * 6.0
                and fill_ratio <= 0.45
            )
            or (
                max(width, height) >= min(mask.shape) * 0.10
                and fill_ratio <= 0.50
            )
        )
        if line_like:
            rejected = cv2.bitwise_or(rejected, component)
        else:
            kept = cv2.bitwise_or(kept, component)
    return kept, rejected


def component_items(mask: np.ndarray, class_name: str) -> list[dict]:
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, 8)
    minimum = {"letter": 90, "diamond": 110, "round": 110, "secondary": 35}[
        class_name
    ]
    items: list[dict] = []
    for index in range(1, count):
        x, y, w, h, area = [int(v) for v in stats[index]]
        if area < minimum or w < 5 or h < 5:
            continue
        cx, cy = [float(v) for v in centroids[index]]
        items.append(
            {
                "class": class_name,
                "center": [round(cx, 2), round(cy, 2)],
                "bbox": [x, y, w, h],
                "area": area,
            }
        )
    return items


def assign_ab(items: list[dict]) -> None:
    if not items:
        return
    heights = [item["bbox"][3] for item in items]
    tolerance = max(18.0, float(np.median(heights)) * 0.75)
    rows: list[list[dict]] = []
    for item in sorted(items, key=lambda value: value["center"][1]):
        selected = None
        selected_distance = None
        for row in rows:
            row_y = float(np.mean([value["center"][1] for value in row]))
            distance = abs(item["center"][1] - row_y)
            if distance <= tolerance and (
                selected_distance is None or distance < selected_distance
            ):
                selected = row
                selected_distance = distance
        if selected is None:
            rows.append([item])
        else:
            selected.append(item)
    rows.sort(key=lambda row: np.mean([value["center"][1] for value in row]))
    sequence = 1
    for row_number, row in enumerate(rows, 1):
        row.sort(key=lambda value: value["center"][0])
        for item in row:
            item["row"] = row_number
            item["sequence_index"] = sequence
            item["replacement"] = "A" if sequence % 2 else "B"
            sequence += 1


def semantic_slot_quality(slots: list[dict]) -> dict[str, object]:
    """Detect self-contradictory RGB labels before expensive image edits."""

    overlap_conflicts: list[dict[str, object]] = []
    for left_index, left in enumerate(slots):
        left_x, left_y, left_width, left_height = left["bbox"]
        left_area = max(1, left_width * left_height)
        for right_index in range(left_index + 1, len(slots)):
            right = slots[right_index]
            if left["class"] == right["class"]:
                continue
            right_x, right_y, right_width, right_height = right["bbox"]
            intersection_width = max(
                0,
                min(left_x + left_width, right_x + right_width)
                - max(left_x, right_x),
            )
            intersection_height = max(
                0,
                min(left_y + left_height, right_y + right_height)
                - max(left_y, right_y),
            )
            intersection = intersection_width * intersection_height
            smaller_area = max(1, min(left_area, right_width * right_height))
            overlap_ratio = intersection / smaller_area
            if overlap_ratio >= 0.70:
                overlap_conflicts.append(
                    {
                        "left_index": left_index,
                        "right_index": right_index,
                        "left_class": left["class"],
                        "right_class": right["class"],
                        "overlap_ratio": round(float(overlap_ratio), 3),
                    }
                )

    secondary = [slot for slot in slots if slot["class"] == "secondary"]
    chain_nodes: set[int] = set()
    for index, slot in enumerate(secondary):
        center_x, center_y = slot["center"]
        neighbours: list[tuple[int, float, float]] = []
        for other_index, other in enumerate(secondary):
            if index == other_index:
                continue
            delta_x = float(other["center"][0] - center_x)
            delta_y = float(other["center"][1] - center_y)
            distance = float(np.hypot(delta_x, delta_y))
            if 10.0 <= distance <= 60.0:
                neighbours.append(
                    (other_index, delta_x / distance, delta_y / distance)
                )
        for first_index in range(len(neighbours)):
            for second_index in range(first_index + 1, len(neighbours)):
                first = neighbours[first_index]
                second = neighbours[second_index]
                direction_dot = first[1] * second[1] + first[2] * second[2]
                if direction_dot <= -0.82:
                    chain_nodes.update((index, first[0], second[0]))

    chain_ratio = len(chain_nodes) / max(1, len(secondary))
    warnings: list[str] = []
    if overlap_conflicts:
        warnings.append("same_region_assigned_to_multiple_motif_classes")
    if len(chain_nodes) >= 6 and chain_ratio >= 0.25:
        warnings.append("secondary_slots_form_dense_linear_chains")
    return {
        "overlap_conflict_count": len(overlap_conflicts),
        "overlap_conflicts": overlap_conflicts[:20],
        "secondary_chain_node_count": len(chain_nodes),
        "secondary_chain_ratio": round(float(chain_ratio), 3),
        "warnings": warnings,
    }


def colored_template(path: Path, color: tuple[int, int, int]) -> Image.Image:
    source = Image.open(path).convert("RGBA")
    alpha = np.asarray(source.getchannel("A"))
    # Only preserve geometry. Every visible source pixel is recolored so no
    # black reference outline can survive into the target layer.
    rgba = np.zeros((source.height, source.width, 4), dtype=np.uint8)
    rgba[:, :, :3] = color
    rgba[:, :, 3] = alpha
    return Image.fromarray(rgba, "RGBA")


def estimate_slot_color(
    source_rgb: np.ndarray,
    class_mask: np.ndarray,
    panel_mask: np.ndarray,
    slot: dict,
) -> tuple[int, int, int]:
    """Estimate the old print color at one RGB slot.

    The RGB label map is slightly approximate, so a raw median can be polluted
    by the bag substrate. Compare pixels under the slot with a surrounding
    panel ring and keep the pixels farthest from the local substrate color.
    This works for light, dark, colored, denim, and metallic old prints.
    """

    x, y, width, height = slot["bbox"]
    pad = max(8, int(round(max(width, height) * 0.35)))
    left, top = max(0, x - pad), max(0, y - pad)
    right = min(source_rgb.shape[1], x + width + pad)
    bottom = min(source_rgb.shape[0], y + height + pad)

    local_source = source_rgb[top:bottom, left:right]
    # Isolate only this connected component.  The padded crop can contain
    # neighbouring motifs, and sampling the entire class mask there mixes the
    # colours of several slots.
    local_object = np.zeros((bottom - top, right - left), dtype=np.uint8)
    object_left = x - left
    object_top = y - top
    local_object[
        object_top : object_top + height,
        object_left : object_left + width,
    ] = class_mask[y : y + height, x : x + width]
    local_object = local_object > 0
    local_panel = panel_mask[top:bottom, left:right] > 0
    local_object &= local_panel
    if int(local_object.sum()) < 8:
        return (182, 132, 53)

    # The generated RGB shape can be displaced by several pixels. Search a
    # modest neighborhood around it instead of sampling only the exact label
    # pixels.
    search_radius = max(2, int(round(max(width, height) * 0.06)))
    search_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE,
        (search_radius * 2 + 1, search_radius * 2 + 1),
    )
    candidate_zone = (
        cv2.dilate(local_object.astype(np.uint8), search_kernel) > 0
    ) & local_panel

    ring_radius = max(search_radius + 4, int(round(max(width, height) * 0.35)))
    ring_kernel = cv2.getStructuringElement(
        cv2.MORPH_ELLIPSE, (ring_radius * 2 + 1, ring_radius * 2 + 1)
    )
    expanded_ring = cv2.dilate(local_object.astype(np.uint8), ring_kernel) > 0
    ring = expanded_ring & ~candidate_zone & local_panel

    object_pixels = local_source[candidate_zone]
    if int(ring.sum()) >= 12:
        substrate = np.median(local_source[ring], axis=0).astype(np.uint8)
    else:
        substrate = np.median(local_source[local_panel], axis=0).astype(np.uint8)

    object_lab = cv2.cvtColor(
        object_pixels.reshape(-1, 1, 3).astype(np.uint8), cv2.COLOR_RGB2LAB
    ).reshape(-1, 3).astype(np.float32)
    substrate_lab = cv2.cvtColor(
        substrate.reshape(1, 1, 3), cv2.COLOR_RGB2LAB
    ).reshape(3).astype(np.float32)
    distances = np.linalg.norm(object_lab - substrate_lab[None, :], axis=1)
    cutoff = float(np.percentile(distances, 60))
    selected = object_pixels[distances >= cutoff]
    if len(selected) < 4:
        selected = object_pixels
    # Leather grain and empty holes inside outline motifs are usually less
    # chromatic than the printed ink.  Removing only the lower-saturation tail
    # keeps coloured, white and embossed prints usable without forcing a hue.
    saturation = (
        selected.max(axis=1).astype(np.float32)
        - selected.min(axis=1).astype(np.float32)
    ) / np.maximum(selected.max(axis=1).astype(np.float32), 1.0)
    saturation_cutoff = float(np.percentile(saturation, 35))
    chromatic = selected[saturation >= saturation_cutoff]
    if len(chromatic) >= 4:
        selected = chromatic
    color = np.median(selected, axis=0)
    return tuple(int(np.clip(round(value), 0, 255)) for value in color)


def estimate_slot_color_from_clean(
    source_rgb: np.ndarray,
    clean_rgb: np.ndarray,
    class_mask: np.ndarray,
    panel_mask: np.ndarray,
    slot: dict,
) -> tuple[int, int, int] | None:
    """Sample old ink by comparing the patterned source with the clean base."""

    x, y, width, height = slot["bbox"]
    pad = max(8, int(round(max(width, height) * 0.55)))
    left, top = max(0, x - pad), max(0, y - pad)
    right = min(source_rgb.shape[1], x + width + pad)
    bottom = min(source_rgb.shape[0], y + height + pad)
    local_object = np.zeros((bottom - top, right - left), dtype=np.uint8)
    object_left = x - left
    object_top = y - top
    local_object[
        object_top : object_top + height,
        object_left : object_left + width,
    ] = class_mask[y : y + height, x : x + width]
    radius = max(4, int(round(max(width, height) * 0.20)))
    candidate = cv2.dilate(
        local_object,
        cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE, (radius * 2 + 1, radius * 2 + 1)
        ),
    ) > 0
    candidate &= panel_mask[top:bottom, left:right] > 0
    if int(candidate.sum()) < 8:
        return None

    ring_radius = max(radius + 5, int(round(max(width, height) * 0.48)))
    ring = cv2.dilate(
        local_object,
        cv2.getStructuringElement(
            cv2.MORPH_ELLIPSE,
            (ring_radius * 2 + 1, ring_radius * 2 + 1),
        ),
    ) > 0
    ring &= ~candidate
    ring &= panel_mask[top:bottom, left:right] > 0
    local_source = source_rgb[top:bottom, left:right]
    local_clean = clean_rgb[top:bottom, left:right]
    source_pixels = local_source[candidate]
    clean_pixels = local_clean[candidate]
    source_lab = cv2.cvtColor(
        source_pixels.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB
    ).reshape(-1, 3).astype(np.float32)
    clean_lab = cv2.cvtColor(
        clean_pixels.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB
    ).reshape(-1, 3).astype(np.float32)
    delta = source_lab - clean_lab
    if int(ring.sum()) >= 12:
        ring_source = cv2.cvtColor(
            local_source[ring].reshape(-1, 1, 3), cv2.COLOR_RGB2LAB
        ).reshape(-1, 3).astype(np.float32)
        ring_clean = cv2.cvtColor(
            local_clean[ring].reshape(-1, 1, 3), cv2.COLOR_RGB2LAB
        ).reshape(-1, 3).astype(np.float32)
        baseline_delta = np.median(ring_source - ring_clean, axis=0)
    else:
        baseline_delta = np.median(delta, axis=0)
    difference = np.linalg.norm(delta - baseline_delta[None, :], axis=1)
    if float(np.percentile(difference, 80)) < 2.5:
        return None
    # Printed outlines can occupy less than 15% of the RGB component box.
    # Keep only the strongest residuals so the surrounding substrate does not
    # dominate low-contrast or fine-line motifs.
    selected = source_pixels[difference >= np.percentile(difference, 90)]
    if len(selected) < 4:
        selected = source_pixels
    color = np.median(selected, axis=0)
    return tuple(int(np.clip(round(value), 0, 255)) for value in color)


def normalize_sampled_colors(
    local_colors: list[tuple[int, int, int]],
) -> tuple[tuple[int, int, int], list[tuple[int, int, int]], bool]:
    if not local_colors:
        return (182, 132, 53), [], False
    color_array = np.asarray(local_colors, dtype=np.float32)
    luminance = (
        color_array[:, 0] * 0.2126
        + color_array[:, 1] * 0.7152
        + color_array[:, 2] * 0.0722
    )
    low, high = np.percentile(luminance, [20, 85])
    stable = color_array[(luminance >= low) & (luminance <= high)]
    if not len(stable):
        stable = color_array
    representative = tuple(
        int(np.clip(round(value), 0, 255))
        for value in np.median(stable, axis=0)
    )
    normalized: list[tuple[int, int, int]] = []
    for color in local_colors:
        values = np.asarray(color, dtype=np.float32)
        value_luminance = float(
            values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
        )
        target_luminance = float(np.clip(value_luminance, low, high))
        if value_luminance > 1.0:
            values *= target_luminance / value_luminance
        normalized.append(
            tuple(int(np.clip(round(value), 0, 255)) for value in values)
        )

    color_rgb = np.asarray(normalized, dtype=np.uint8)
    color_lab = cv2.cvtColor(
        color_rgb.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB
    ).reshape(-1, 3).astype(np.float32)
    representative_lab = cv2.cvtColor(
        np.asarray(representative, dtype=np.uint8).reshape(1, 1, 3),
        cv2.COLOR_RGB2LAB,
    ).reshape(3).astype(np.float32)
    chroma_distance = np.linalg.norm(
        color_lab[:, 1:] - representative_lab[None, 1:], axis=1
    )
    multicolor = float(np.mean(chroma_distance > 18.0)) >= 0.18
    if not multicolor:
        corrected: list[tuple[int, int, int]] = []
        representative_values = np.asarray(representative, dtype=np.float32)
        representative_luminance = float(
            representative_values[0] * 0.2126
            + representative_values[1] * 0.7152
            + representative_values[2] * 0.0722
        )
        for index, values in enumerate(color_rgb.astype(np.float32)):
            if chroma_distance[index] > 18.0:
                local_luminance = float(
                    values[0] * 0.2126
                    + values[1] * 0.7152
                    + values[2] * 0.0722
                )
                values = representative_values.copy()
                if representative_luminance > 1.0:
                    values *= local_luminance / representative_luminance
            corrected.append(
                tuple(int(np.clip(round(value), 0, 255)) for value in values)
            )
        normalized = corrected
    return representative, normalized, multicolor


def direct_single_print_color(
    source_rgb: np.ndarray,
    class_masks: dict[str, np.ndarray],
    residual_color: tuple[int, int, int],
) -> tuple[int, int, int] | None:
    """Use the visible old ink body when it agrees with the residual hue.

    Strong source-vs-clean residuals overemphasize dark antialiased edges.
    The direct semantic-mask median better represents the visible print body,
    but is accepted only when it remains close to the residual estimate so
    hollow outline motifs cannot replace ink color with substrate color.
    """

    union = np.zeros(source_rgb.shape[:2], dtype=np.uint8)
    for mask in class_masks.values():
        union = cv2.bitwise_or(union, mask)
    pixels = source_rgb[union > 0]
    if len(pixels) < 24:
        return None
    direct = np.median(pixels, axis=0).astype(np.uint8)
    pair = np.asarray([residual_color, tuple(int(v) for v in direct)], dtype=np.uint8)
    pair_lab = cv2.cvtColor(pair.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB).reshape(-1, 3)
    distance = float(
        np.linalg.norm(pair_lab[0].astype(np.float32) - pair_lab[1].astype(np.float32))
    )
    if distance > 15.0:
        return None
    return tuple(int(value) for value in direct)


def match_final_pattern_chroma(
    final_image: Image.Image,
    pattern_layer: Image.Image,
) -> tuple[Image.Image, list[float]]:
    """Match final motif hue/chroma to the approved target without flattening texture."""

    final_rgb = np.asarray(final_image.convert("RGB"))
    layer_rgba = np.asarray(pattern_layer.convert("RGBA"))
    alpha = layer_rgba[:, :, 3].astype(np.float32) / 255.0
    region = alpha >= 0.45
    if int(region.sum()) < 32:
        return final_image.convert("RGB"), [0.0, 0.0]
    final_lab = cv2.cvtColor(final_rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    target_lab = cv2.cvtColor(
        layer_rgba[:, :, :3], cv2.COLOR_RGB2LAB
    ).astype(np.float32)
    delta_ab = np.median(
        target_lab[region, 1:3] - final_lab[region, 1:3], axis=0
    )
    delta_ab = np.clip(delta_ab, -18.0, 18.0)
    weight = (alpha * alpha)[:, :, None]
    corrected = final_lab.copy()
    corrected[:, :, 1:3] = np.clip(
        corrected[:, :, 1:3] + weight * delta_ab.reshape(1, 1, 2),
        0,
        255,
    )
    corrected_rgb = cv2.cvtColor(
        corrected.astype(np.uint8), cv2.COLOR_LAB2RGB
    )
    return Image.fromarray(corrected_rgb, "RGB"), [
        round(float(delta_ab[0]), 3),
        round(float(delta_ab[1]), 3),
    ]


def restore_preserved_lines(
    source_image: Image.Image,
    target_image: Image.Image,
    line_mask: Image.Image,
    exclusion_mask: Image.Image | None = None,
) -> tuple[Image.Image, int]:
    """Blend preserved source line pixels back without covering new motifs."""

    target = target_image.convert("RGB")
    source = source_image.convert("RGB").resize(
        target.size, Image.Resampling.LANCZOS
    )
    mask = np.asarray(
        line_mask.convert("L").resize(target.size, Image.Resampling.NEAREST)
    )
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8))
    if exclusion_mask is not None:
        exclusion = np.asarray(
            exclusion_mask.convert("L").resize(
                target.size, Image.Resampling.NEAREST
            )
        )
        exclusion = cv2.dilate(exclusion, np.ones((5, 5), np.uint8))
        mask = np.where(exclusion > 0, 0, mask).astype(np.uint8)
    restored_pixels = int((mask > 0).sum())
    if restored_pixels == 0:
        return target, 0
    alpha = cv2.GaussianBlur(mask, (0, 0), 0.8).astype(np.float32) / 255.0
    alpha = alpha[:, :, None]
    source_array = np.asarray(source).astype(np.float32)
    target_array = np.asarray(target).astype(np.float32)
    result = source_array * alpha + target_array * (1.0 - alpha)
    return Image.fromarray(np.clip(result, 0, 255).astype(np.uint8), "RGB"), restored_pixels


def paste_motif(
    canvas: Image.Image,
    motif: Image.Image,
    center: tuple[float, float],
    box: tuple[int, int],
) -> None:
    copy = motif.copy()
    copy.thumbnail(box, Image.Resampling.LANCZOS)
    x = int(round(center[0] - copy.width / 2))
    y = int(round(center[1] - copy.height / 2))
    canvas.alpha_composite(copy, (x, y))


def align_edit_to_base(
    base: np.ndarray, edit: np.ndarray, preserve_mask: np.ndarray
) -> tuple[np.ndarray, dict]:
    edit = cv2.resize(
        edit, (base.shape[1], base.shape[0]), interpolation=cv2.INTER_LANCZOS4
    )
    gray_base = cv2.cvtColor(base, cv2.COLOR_BGR2GRAY)
    gray_edit = cv2.cvtColor(edit, cv2.COLOR_BGR2GRAY)
    sift = cv2.SIFT_create(nfeatures=7000, contrastThreshold=0.01)
    key_base, desc_base = sift.detectAndCompute(gray_base, preserve_mask)
    key_edit, desc_edit = sift.detectAndCompute(gray_edit, None)
    matcher = cv2.FlannBasedMatcher(
        {"algorithm": 1, "trees": 5}, {"checks": 100}
    )
    pairs = matcher.knnMatch(desc_edit, desc_base, k=2)
    good = [first for first, second in pairs if first.distance < 0.7 * second.distance]
    source_points = np.float32(
        [key_edit[match.queryIdx].pt for match in good]
    ).reshape(-1, 1, 2)
    target_points = np.float32(
        [key_base[match.trainIdx].pt for match in good]
    ).reshape(-1, 1, 2)
    homography, inliers = cv2.findHomography(
        source_points, target_points, cv2.RANSAC, 3.0
    )
    aligned = cv2.warpPerspective(
        edit,
        homography,
        (base.shape[1], base.shape[0]),
        flags=cv2.INTER_LANCZOS4,
        borderMode=cv2.BORDER_REFLECT,
    )
    return aligned, {
        "feature_matches": len(good),
        "homography_inliers": int(inliers.sum()),
    }


def stage_label(source: Path, out: Path, report: dict) -> None:
    raw = out / "01_rgb_label_raw.png"
    started = time.perf_counter()
    report["rgb_label_api"] = api_client().edit_images(
        [source],
        LABEL_PROMPT,
        raw,
        model="gpt-image-2",
        size=request_size_for(source),
        quality="high",
        input_fidelity="high",
    )
    source_size = Image.open(source).size
    aligned = Image.open(raw).convert("RGB").resize(
        source_size, Image.Resampling.NEAREST
    )
    aligned.save(out / "02_rgb_label_aligned.png")
    report["rgb_label_stage_seconds"] = round(time.perf_counter() - started, 3)


def stage_build(source: Path, out: Path, report: dict) -> list[dict]:
    started = time.perf_counter()
    source_image = Image.open(source).convert("RGB")
    source_rgb = np.asarray(source_image)
    source_image.save(out / "00_source.png")
    label = Image.open(out / "02_rgb_label_aligned.png").convert("RGB")
    masks = decode(np.asarray(label))

    class_masks: dict[str, np.ndarray] = {}
    slots: list[dict] = []
    preserved_lines = np.zeros(
        (source_image.height, source_image.width), dtype=np.uint8
    )
    for name in ("letter", "diamond", "round", "secondary"):
        if name == "secondary":
            raw_secondary_pixels = int((masks[name] > 0).sum())
            secondary_without_lines, preserved_lines = split_secondary_lines(
                masks[name]
            )
            cleaned = clean_class_mask(secondary_without_lines, name)
            masks["panel"] = cv2.bitwise_or(masks["panel"], preserved_lines)
            report["secondary_line_split"] = {
                "raw_secondary_pixels": raw_secondary_pixels,
                "kept_motif_pixels": int((cleaned > 0).sum()),
                "preserved_line_pixels": int((preserved_lines > 0).sum()),
            }
        else:
            cleaned = clean_class_mask(masks[name], name)
        class_masks[name] = cleaned
        Image.fromarray(class_masks[name], "L").save(out / f"02_mask_{name}.png")
        slots.extend(component_items(class_masks[name], name))
    Image.fromarray(preserved_lines, "L").save(out / "02_mask_preserved_lines.png")

    secondary = [slot for slot in slots if slot["class"] == "secondary"]
    assign_ab(secondary)
    for slot in slots:
        if slot["class"] != "secondary":
            slot["replacement"] = slot["class"]
            slot["row"] = None
            slot["sequence_index"] = None

    motif_union = np.zeros((source_image.height, source_image.width), dtype=np.uint8)
    for value in class_masks.values():
        motif_union = cv2.bitwise_or(motif_union, value)

    panel = cv2.bitwise_or(masks["panel"], motif_union)
    panel = cv2.morphologyEx(
        panel, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8)
    )
    white_foreground = white_background_foreground_mask(source_rgb)
    if white_foreground is not None:
        panel = cv2.bitwise_and(panel, white_foreground)
    count, labels, stats, _ = cv2.connectedComponentsWithStats(panel, 8)
    if count > 1:
        component_areas = stats[1:, cv2.CC_STAT_AREA]
        largest_area = int(component_areas.max())
        # A single product can have several visible patterned panels separated
        # by leather trim, handles or folds.  Keeping only the largest connected
        # component caused the old batch to lose side and pocket panels.
        minimum_area = max(80, int(round(largest_area * 0.015)))
        retained = [
            index + 1
            for index, area in enumerate(component_areas)
            if int(area) >= minimum_area
        ]
        panel = np.where(np.isin(labels, retained), 255, 0).astype(np.uint8)
    if white_foreground is not None:
        panel = refine_panel_bottom_on_white(source_rgb, panel)

    filtered_slots: list[dict] = []
    for slot in slots:
        x, y, width, height = slot["bbox"]
        component = class_masks[slot["class"]][
            y : y + height, x : x + width
        ] > 0
        retained_component = panel[y : y + height, x : x + width] > 0
        overlap = int(np.logical_and(component, retained_component).sum())
        if overlap >= max(8, int(round(component.sum() * 0.35))):
            filtered_slots.append(slot)
    slots = filtered_slots
    secondary = [slot for slot in slots if slot["class"] == "secondary"]
    assign_ab(secondary)
    for slot in slots:
        if slot["class"] != "secondary":
            slot["replacement"] = slot["class"]
            slot["row"] = None
            slot["sequence_index"] = None

    motif_union = cv2.bitwise_and(motif_union, panel)
    Image.fromarray(panel, "L").save(out / "02_mask_panel.png")

    motif_clean = cv2.dilate(
        motif_union, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (13, 13))
    )
    Image.fromarray(motif_clean, "L").save(out / "02_mask_all_motifs.png")
    rgba_edit_mask(motif_clean, out / "02_clean_edit_mask.png")
    rgba_edit_mask(panel, out / "06_final_mask.png")

    medians: dict[str, tuple[float, float]] = {}
    for name in ("letter", "diamond", "round", "secondary"):
        selected = [slot for slot in slots if slot["class"] == name]
        medians[name] = (
            float(np.median([slot["bbox"][2] for slot in selected] or [40])),
            float(np.median([slot["bbox"][3] for slot in selected] or [40])),
        )

    local_colors = []
    for slot in slots:
        local_color = estimate_slot_color(
            source_rgb,
            class_masks[slot["class"]],
            panel,
            slot,
        )
        slot["sampled_local_color"] = list(local_color)
        local_colors.append(local_color)
    if local_colors:
        color_array = np.asarray(local_colors, dtype=np.float32)
        luminance = (
            color_array[:, 0] * 0.2126
            + color_array[:, 1] * 0.7152
            + color_array[:, 2] * 0.0722
        )
        low, high = np.percentile(luminance, [20, 85])
        stable = color_array[(luminance >= low) & (luminance <= high)]
        if not len(stable):
            stable = color_array
        representative_print_color = tuple(
            int(np.clip(round(value), 0, 255))
            for value in np.median(stable, axis=0)
        )
    else:
        low, high = 0.0, 255.0
        representative_print_color = (182, 132, 53)

    # Keep the hue sampled from every old slot (important for multicolour
    # products), but clamp only extreme exposure errors caused by shadows,
    # highlights or slight RGB-map displacement.
    normalized_colors: list[tuple[int, int, int]] = []
    for color in local_colors:
        values = np.asarray(color, dtype=np.float32)
        value_luminance = float(
            values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
        )
        target_luminance = float(np.clip(value_luminance, low, high))
        if value_luminance > 1.0:
            values *= target_luminance / value_luminance
        normalized_colors.append(
            tuple(int(np.clip(round(value), 0, 255)) for value in values)
        )

    multicolor_detected = False
    if normalized_colors:
        color_rgb = np.asarray(normalized_colors, dtype=np.uint8)
        color_lab = cv2.cvtColor(
            color_rgb.reshape(-1, 1, 3), cv2.COLOR_RGB2LAB
        ).reshape(-1, 3).astype(np.float32)
        representative_lab = cv2.cvtColor(
            np.asarray(representative_print_color, dtype=np.uint8).reshape(1, 1, 3),
            cv2.COLOR_RGB2LAB,
        ).reshape(3).astype(np.float32)
        chroma_distance = np.linalg.norm(
            color_lab[:, 1:] - representative_lab[None, 1:], axis=1
        )
        multicolor_detected = float(np.mean(chroma_distance > 18.0)) >= 0.18
        if not multicolor_detected:
            corrected_colors: list[tuple[int, int, int]] = []
            representative = np.asarray(
                representative_print_color, dtype=np.float32
            )
            representative_luminance = float(
                representative[0] * 0.2126
                + representative[1] * 0.7152
                + representative[2] * 0.0722
            )
            for index, values in enumerate(color_rgb.astype(np.float32)):
                if chroma_distance[index] > 18.0:
                    local_luminance = float(
                        values[0] * 0.2126
                        + values[1] * 0.7152
                        + values[2] * 0.0722
                    )
                    values = representative.copy()
                    if representative_luminance > 1.0:
                        values *= local_luminance / representative_luminance
                corrected_colors.append(
                    tuple(int(np.clip(round(value), 0, 255)) for value in values)
                )
            normalized_colors = corrected_colors

    target = Image.new("RGBA", source_image.size, (0, 0, 0, 0))
    for slot_index, slot in enumerate(slots):
        _, _, width, height = slot["bbox"]
        median_width, median_height = medians[slot["class"]]
        if width < median_width * 0.48 or height < median_height * 0.48:
            width, height = int(round(median_width)), int(round(median_height))
        replacement = slot["replacement"]
        target_size = (
            max(12, int(round(width * 1.03))),
            max(12, int(round(height * 1.03))),
        )
        slot["target_size"] = list(target_size)
        sampled_color = (
            normalized_colors[slot_index]
            if slot_index < len(normalized_colors)
            else representative_print_color
        )
        slot["sampled_color"] = list(sampled_color)
        paste_motif(
            target,
            colored_template(ELEMENTS[replacement], sampled_color),
            tuple(slot["center"]),
            target_size,
        )

    target_array = np.asarray(target).copy()
    target_array[:, :, 3] = np.where(
        panel > 0, target_array[:, :, 3], 0
    ).astype(np.uint8)
    target = Image.fromarray(target_array, "RGBA")
    target.save(out / "04_new_pattern_layer.png")

    report["counts"] = {
        name: sum(slot["class"] == name for slot in slots)
        for name in ("letter", "diamond", "round", "secondary")
    }
    report["slot_count"] = len(slots)
    report["sampled_print_color"] = list(representative_print_color)
    report["sampled_print_colors"] = [list(color) for color in normalized_colors]
    report["multicolor_print_detected"] = multicolor_detected
    semantic_quality = semantic_slot_quality(slots)
    quality_warnings: list[str] = list(semantic_quality["warnings"])
    if not slots:
        quality_warnings.append("no_pattern_slots_detected")
    split_metrics = report.get("secondary_line_split", {})
    if (
        int(split_metrics.get("raw_secondary_pixels", 0)) > 0
        and int(split_metrics.get("kept_motif_pixels", 0)) == 0
        and int(split_metrics.get("preserved_line_pixels", 0)) > 0
    ):
        quality_warnings.append(
            "all_secondary_candidates_were_reclassified_as_lines"
        )
    report["quality_gate"] = {
        "status": "review" if quality_warnings else "passed",
        "warnings": quality_warnings,
        "metrics": semantic_quality,
    }
    report["build_stage_seconds"] = round(time.perf_counter() - started, 3)
    (out / "slot_plan.json").write_text(
        json.dumps(
            {
                "source": str(source),
                "counts": report["counts"],
                "slots": sorted(
                    slots, key=lambda value: (value["center"][1], value["center"][0])
                ),
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )
    return slots


def rebuild_target_from_clean(
    source: Path, out: Path, clean_image: Image.Image, report: dict
) -> None:
    """Recolour and render target motifs using source-vs-clean differences."""

    plan_path = out / "slot_plan.json"
    plan_data = json.loads(plan_path.read_text(encoding="utf-8"))
    slots = plan_data["slots"]
    source_rgb = np.asarray(Image.open(source).convert("RGB"))
    clean_rgb = np.asarray(clean_image)
    panel_array = np.asarray(Image.open(out / "02_mask_panel.png").convert("L"))
    class_masks = {
        name: np.asarray(Image.open(out / f"02_mask_{name}.png").convert("L"))
        for name in ("letter", "diamond", "round", "secondary")
    }
    local_colors: list[tuple[int, int, int]] = []
    valid_slots: list[dict] = []
    for slot in slots:
        local_color = estimate_slot_color_from_clean(
            source_rgb,
            clean_rgb,
            class_masks[slot["class"]],
            panel_array,
            slot,
        )
        if local_color is None:
            continue
        slot["sampled_local_color_from_clean"] = list(local_color)
        valid_slots.append(slot)
        local_colors.append(local_color)
    slots = valid_slots
    secondary = [slot for slot in slots if slot["class"] == "secondary"]
    assign_ab(secondary)
    for slot in slots:
        if slot["class"] != "secondary":
            slot["replacement"] = slot["class"]
            slot["row"] = None
            slot["sequence_index"] = None
    plan_data["slots"] = slots
    representative, normalized_colors, multicolor = normalize_sampled_colors(
        local_colors
    )
    direct_color = None
    if not multicolor:
        direct_color = direct_single_print_color(
            source_rgb, class_masks, representative
        )
        if direct_color is not None:
            representative = direct_color
            normalized_colors = [direct_color for _ in local_colors]
    rebuilt_target = Image.new("RGBA", clean_image.size, (0, 0, 0, 0))
    for slot_index, slot in enumerate(slots):
        sampled_color = (
            normalized_colors[slot_index]
            if slot_index < len(normalized_colors)
            else representative
        )
        slot["sampled_color"] = list(sampled_color)
        paste_motif(
            rebuilt_target,
            colored_template(ELEMENTS[slot["replacement"]], sampled_color),
            tuple(slot["center"]),
            tuple(slot["target_size"]),
        )
    rebuilt_array = np.asarray(rebuilt_target).copy()
    rebuilt_array[:, :, 3] = np.where(
        panel_array > 0, rebuilt_array[:, :, 3], 0
    ).astype(np.uint8)
    Image.fromarray(rebuilt_array, "RGBA").save(out / "04_new_pattern_layer.png")
    plan_path.write_text(
        json.dumps(plan_data, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    report["sampled_print_color"] = list(representative)
    report["sampled_print_colors"] = [list(color) for color in normalized_colors]
    report["multicolor_print_detected"] = multicolor
    report["direct_mask_print_color"] = (
        list(direct_color) if direct_color is not None else None
    )
    report["color_sampling_source"] = "source_minus_clean_base"
    report["slot_count"] = len(slots)
    report["counts"] = {
        name: sum(slot["class"] == name for slot in slots)
        for name in ("letter", "diamond", "round", "secondary")
    }

    target = Image.open(out / "04_new_pattern_layer.png").convert("RGBA").resize(
        clean_image.size, Image.Resampling.LANCZOS
    )
    panel = Image.open(out / "02_mask_panel.png").convert("L").resize(
        clean_image.size, Image.Resampling.NEAREST
    )
    target_array = np.asarray(target).copy()
    target_array[:, :, 3] = np.where(
        np.asarray(panel) > 0, target_array[:, :, 3], 0
    ).astype(np.uint8)
    target = Image.fromarray(target_array, "RGBA")
    target.save(out / "04_new_pattern_layer_clean_coords.png")

    clean_rgba = clean_image.convert("RGBA")
    clean_rgba.alpha_composite(target)
    clean_rgba.convert("RGB").save(out / "05_target_preview.png")
    rgba_edit_mask(np.asarray(panel), out / "06_final_mask.png")


def stage_clean_and_target(source: Path, out: Path, report: dict) -> None:
    clean_raw = out / "03_clean_raw.png"
    started = time.perf_counter()
    report["clean_api"] = api_client().edit_images(
        [source],
        CLEAN_PROMPT,
        clean_raw,
        model="gpt-image-2",
        size=request_size_for(source),
        quality="high",
        mask=out / "02_clean_edit_mask.png",
        input_fidelity="high",
    )
    source_size = Image.open(source).size
    normalize_output_size(clean_raw, source_size)
    report["clean_api"]["normalized_output_size"] = list(source_size)
    # The image model already returns a coherent clean product image. Do not
    # paste small cleaned patches back into the patterned source: doing so
    # preserves old-print halos between/around the small RGB motif masks.
    clean_image = Image.open(clean_raw).convert("RGB")
    clean_image, restored_line_pixels = restore_preserved_lines(
        Image.open(source).convert("RGB"),
        clean_image,
        Image.open(out / "02_mask_preserved_lines.png"),
    )
    clean_image.save(out / "03_clean_base.png")
    report["clean_restored_line_pixels"] = restored_line_pixels
    rebuild_target_from_clean(source, out, clean_image, report)
    report["clean_base_source"] = "direct_ai_clean_output"
    report.pop("clean_alignment", None)
    report["clean_and_target_stage_seconds"] = round(
        time.perf_counter() - started, 3
    )


def stage_retarget(source: Path, out: Path, report: dict) -> None:
    started = time.perf_counter()
    clean_image = Image.open(out / "03_clean_base.png").convert("RGB")
    rebuild_target_from_clean(source, out, clean_image, report)
    report["retarget_stage_seconds"] = round(time.perf_counter() - started, 3)


def stage_final(out: Path, report: dict) -> None:
    started = time.perf_counter()
    final_size = Image.open(out / "03_clean_base.png").size
    final_mask_path = out / "06_final_mask.png"
    final_mask = Image.open(final_mask_path).convert("RGBA")
    if final_mask.size != final_size:
        final_mask = final_mask.resize(final_size, Image.Resampling.NEAREST)
        final_mask.save(final_mask_path)
    final_output = out / "07_final_ai.png"
    if final_output.exists():
        history = out / "_history"
        history.mkdir(parents=True, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        archived = history / f"07_final_ai_{timestamp}.png"
        shutil.copy2(final_output, archived)
        report.setdefault("archived_final_outputs", []).append(str(archived))
    final_prompt = FINAL_PROMPT
    sampled_color = report.get("sampled_print_color")
    if isinstance(sampled_color, list) and len(sampled_color) == 3:
        final_prompt += (
            "\nThe original print color sampled from the source is "
            f"RGB({sampled_color[0]},{sampled_color[1]},{sampled_color[2]}). "
            "Match this print hue and saturation closely while retaining natural "
            "surface lighting and texture."
        )
    report["final_api"] = api_client().edit_images(
        [out / "03_clean_base.png", out / "05_target_preview.png"],
        final_prompt,
        final_output,
        model="gpt-image-2",
        size=request_size_for(out / "03_clean_base.png"),
        quality="high",
        mask=final_mask_path,
        input_fidelity="high",
    )
    normalize_output_size(final_output, final_size)
    pattern_alpha = Image.open(
        out / "04_new_pattern_layer_clean_coords.png"
    ).convert("RGBA").getchannel("A")
    final_image, restored_line_pixels = restore_preserved_lines(
        Image.open(out / "00_source.png").convert("RGB"),
        Image.open(final_output).convert("RGB"),
        Image.open(out / "02_mask_preserved_lines.png"),
        exclusion_mask=pattern_alpha,
    )
    if not bool(report.get("multicolor_print_detected", False)):
        final_image, chroma_delta = match_final_pattern_chroma(
            final_image,
            Image.open(out / "04_new_pattern_layer_clean_coords.png"),
        )
        report["final_pattern_chroma_delta_ab"] = chroma_delta
        if any(abs(float(value)) >= 1.0 for value in chroma_delta):
            report.setdefault("automatic_corrections", []).append(
                {
                    "type": "single_color_pattern_chroma_lock",
                    "delta_ab": chroma_delta,
                }
            )
    final_image.save(final_output)
    report["final_restored_line_pixels"] = restored_line_pixels
    report["final_api"]["normalized_output_size"] = list(final_size)
    report["final_stage_seconds"] = round(time.perf_counter() - started, 3)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument(
        "--stage",
        choices=("label", "build", "clean", "retarget", "final", "all"),
        default="all",
    )
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    report_path = args.output / "run_report.json"
    report = (
        json.loads(report_path.read_text(encoding="utf-8"))
        if report_path.exists()
        else {"source": str(args.input), "started_at_epoch": time.time()}
    )
    started = time.perf_counter()

    if args.stage in ("label", "all"):
        stage_label(args.input, args.output, report)
    if args.stage in ("build", "all"):
        stage_build(args.input, args.output, report)
    if args.stage in ("clean", "all"):
        stage_clean_and_target(args.input, args.output, report)
    if args.stage == "retarget":
        stage_retarget(args.input, args.output, report)
    if args.stage in ("final", "all"):
        stage_final(args.output, report)

    report["last_stage"] = args.stage
    report["last_command_seconds"] = round(time.perf_counter() - started, 3)
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
