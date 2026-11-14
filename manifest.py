import hashlib
import json
import ntpath
import os
import re
from pathlib import PurePosixPath

import folder_paths


LOADERS = {
    "CheckpointLoaderSimple": {"ckpt_name": "checkpoints"},
    "CheckpointLoader": {"ckpt_name": "checkpoints"},
    "unCLIPCheckpointLoader": {"ckpt_name": "checkpoints"},
    "ImageOnlyCheckpointLoader": {"ckpt_name": "checkpoints"},
    "UNETLoader": {"unet_name": "diffusion_models"},
    "UnetLoaderGGUF": {"unet_name": "diffusion_models"},
    "UnetLoaderGGUFAdvanced": {"unet_name": "diffusion_models"},
    "CLIPLoader": {"clip_name": "text_encoders"},
    "CLIPLoaderGGUF": {"clip_name": "text_encoders"},
    "DualCLIPLoader": {"clip_name1": "text_encoders", "clip_name2": "text_encoders"},
    "DualCLIPLoaderGGUF": {"clip_name1": "text_encoders", "clip_name2": "text_encoders"},
    "TripleCLIPLoader": {f"clip_name{i}": "text_encoders" for i in range(1, 4)},
    "QuadrupleCLIPLoader": {f"clip_name{i}": "text_encoders" for i in range(1, 5)},
    "VAELoader": {"vae_name": "vae"},
    "LoraLoader": {"lora_name": "loras"},
    "LoraLoaderModelOnly": {"lora_name": "loras"},
    "ControlNetLoader": {"control_net_name": "controlnet"},
    "DiffControlNetLoader": {"control_net_name": "controlnet"},
    "CLIPVisionLoader": {"clip_name": "clip_vision"},
    "StyleModelLoader": {"style_model_name": "style_models"},
    "GLIGENLoader": {"gligen_name": "gligen"},
    "UpscaleModelLoader": {"model_name": "upscale_models"},
    "LatentUpscaleModelLoader": {"model_name": "latent_upscale_models"},
    "PhotoMakerLoader": {"photomaker_model_name": "photomaker"},
}
NON_MODEL_FOLDERS = {"custom_nodes", "configs", "datasets", "diffusers"}
MODEL_EXTENSIONS = {".safetensors", ".sft", ".ckpt", ".pt", ".pt2", ".pth", ".bin", ".pkl", ".gguf", ".onnx", ".tflite", ".model", ".json", ".txt", ".vocab", ".yaml", ".yml"}
RESERVED_NAME = re.compile(r"^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)", re.I)
VAE_APPROX_MODELS = ("taehv", "lighttaew2_2", "lighttaew2_1", "lighttaehy1_5", "taeltx_2")
MANIFEST_NODE = "GW/ModelManifest"


def read_manifest(value):
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("models"), list):
        raise ValueError("模型清单必须包含 version: 1 和 models 数组")
    if len(value["models"]) > 5000 or any(not isinstance(model, dict) for model in value["models"]):
        raise ValueError("模型清单最多包含 5000 个模型对象")
    return value


def resolve_selected_model(selection, value):
    if not isinstance(selection, str) or not selection:
        raise ValueError("请在 GW 模型依赖节点选择模型后连接加载器")
    for model in read_manifest(value)["models"]:
        path = str(model.get("relative_path", "")).replace("\\", "/")
        key = f"{folder_paths.map_legacy(str(model.get('category', '')))}/{path}"
        if key == selection.replace("\\", "/"):
            if model.get("enabled", True) is False:
                raise ValueError(f"选择的模型已停用：{selection}")
            return normalize_model(model)
    raise ValueError(f"选择的模型未登记：{selection}")


def categories():
    return sorted(name for name in folder_paths.folder_names_and_paths if name not in NON_MODEL_FOLDERS)


def relative_path(value):
    if not isinstance(value, str) or not value.strip():
        raise ValueError("模型相对路径不能为空")
    value = value.replace("\\", "/")
    parts = value.split("/")
    if ntpath.splitdrive(value)[0] or value.startswith("/") or any(
        part in ("", ".", "..") or part.endswith((" ", ".")) or RESERVED_NAME.match(part)
        or re.search(r'[<>:"|?*\x00-\x1f\x7f]', part) for part in parts
    ):
        raise ValueError(f"不允许的模型相对路径：{value}")
    if PurePosixPath(value).suffix.lower() not in MODEL_EXTENSIONS:
        raise ValueError(f"不支持的模型文件扩展名：{value}")
    return value


def normalize_model(model):
    if not isinstance(model, dict):
        raise ValueError("模型条目必须是对象")
    category = folder_paths.map_legacy(str(model.get("category", "")))
    if category not in categories():
        raise ValueError(f"未知或不允许的模型类别：{category or '未选择'}")
    path = relative_path(model.get("relative_path"))
    url = model.get("url", "")
    if not isinstance(url, str):
        raise ValueError(f"{path} 的下载地址必须是字符串")
    sha256 = str(model.get("sha256", "")).strip().lower()
    if sha256 and not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValueError(f"{path} 的 SHA256 必须是 64 位十六进制字符串")
    size = model.get("size_bytes")
    if size not in (None, ""):
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise ValueError(f"{path} 的预期大小必须是正整数字节数")
    else:
        size = None
    return {"category": category, "relative_path": path, "url": url.strip(), "sha256": sha256, "size_bytes": size}


def merge_models(models):
    if not isinstance(models, list) or len(models) > 5000:
        raise ValueError("模型清单必须是数组，且不能超过 5000 条")
    merged = {}
    for model in models:
        if not isinstance(model, dict):
            raise ValueError("模型条目必须是对象")
        if model.get("enabled", True) is False:
            continue
        item = normalize_model(model)
        key = (item["category"], os.path.normcase(item["relative_path"]))
        previous = merged.get(key)
        if previous is None:
            merged[key] = item
            continue
        for field in ("url", "sha256", "size_bytes"):
            if item[field] and previous[field] and item[field] != previous[field]:
                raise ValueError(f"模型清单冲突：{item['category']}/{item['relative_path']} 的 {field} 不一致")
            if item[field]:
                previous[field] = item[field]
    return list(merged.values())


def contained_path(root, path):
    target = os.path.abspath(os.path.join(root, *path.split("/")))
    if not folder_paths.is_within_directory(root, target):
        raise ValueError(f"模型路径超出允许目录：{path}")
    return target


def check_models(models, root_indices=None, verify_sha256=False):
    root_indices = root_indices or {}
    if not isinstance(root_indices, dict):
        raise ValueError("本机模型目录设置必须是对象")
    results = []
    for model in merge_models(models):
        roots = folder_paths.get_folder_paths(model["category"])
        if not roots:
            raise ValueError(f"模型类别没有配置目录：{model['category']}")
        root_index = root_indices.get(model["category"], 0)
        if isinstance(root_index, bool) or not isinstance(root_index, int) or not 0 <= root_index < len(roots):
            raise ValueError(f"{model['category']} 的本机目录设置已失效，请重新选择")
        result = {**model, "status": "missing", "root": roots[root_index], "loader_value": os.path.join(*model["relative_path"].split("/")), "target_path": contained_path(roots[root_index], model["relative_path"])}
        for root in roots:
            path = contained_path(root, model["relative_path"])
            if not os.path.isfile(path):
                continue
            size = os.path.getsize(path)
            result.update(target_path=path, actual_size=size)
            if size == 0 or (model["size_bytes"] and size != model["size_bytes"]):
                result.update(status="invalid", error="已有文件大小不符，请移走或删除该文件后重新下载")
            else:
                result["status"] = "exists"
                if verify_sha256 and model["sha256"]:
                    with open(path, "rb") as source:
                        digest = hashlib.file_digest(source, "sha256").hexdigest()
                    if digest != model["sha256"]:
                        result.update(status="invalid", error="已有文件 SHA256 不符，请移走后重新下载")
                    else:
                        result["hash_verified"] = True
            break
        if result["status"] == "missing" and not model["url"]:
            result.update(status="no_url", error="缺少下载地址")
        results.append(result)
    return results


def scan_nodes(node_list, metadata=()):
    found = {}
    warnings = []
    index = None
    metadata = list(metadata)
    for node in node_list:
        metadata.extend(node.get("models") or [])
    by_path = {}
    for model in metadata:
        directory = str(model.get("directory", "")).replace("\\", "/").removeprefix("models/").strip("/")
        category = folder_paths.map_legacy(directory)
        if category in categories():
            by_path[(category, str(model.get("name", "")).replace("\\", "/"))] = model

    for node in node_list:
        node_type = node.get("node_type", "")
        known = LOADERS.get(node_type, {})
        inputs = node.get("inputs", {})
        if node_type == MANIFEST_NODE:
            if not inputs.get("selected_model"):
                continue
            value = read_manifest(inputs.get("manifest"))
            if value.get("enabled", True) is False:
                continue
            model = resolve_selected_model(inputs["selected_model"], value)
            key = (model["category"], model["relative_path"])
            if key not in found:
                found[key] = {**model, "source": "scan", "enabled": True, "references": []}
            found[key]["references"].append({"node_id": str(node.get("node_id", "")), "input_name": "selected_model"})
            continue
        if node_type == "VAELoader" and inputs.get("vae_name") in ("taesd", "taesdxl", "taesd3", "taef1", "taef2"):
            warnings.append(f"VAELoader：{inputs['vae_name']} 使用分体编码器／解码器，请手动添加到 vae_approx 类别")
        for input_name, value in inputs.items():
            if not isinstance(value, str) or PurePosixPath(value.replace("\\", "/")).suffix.lower() not in MODEL_EXTENSIONS:
                continue
            path = value.replace("\\", "/")
            category = known.get(input_name)
            if node_type == "VAELoader" and input_name == "vae_name" and PurePosixPath(path).stem in VAE_APPROX_MODELS:
                category = "vae_approx"
            if category == "vae" and PurePosixPath(path).suffix.lower() not in {".safetensors", ".sft", ".ckpt", ".pt", ".pth"}:
                continue
            if not category:
                matches = [cat for cat, name in by_path if name == path]
                if not matches:
                    if index is None:
                        index = {}
                        for cat in categories():
                            for name in folder_paths.get_filename_list(cat):
                                index.setdefault(name.replace("\\", "/"), []).append(cat)
                    matches = index.get(path, [])
                category = matches[0] if len(set(matches)) == 1 else ""
            if not category and not any(word in input_name.lower() for word in ("model", "ckpt", "lora", "vae", "clip", "unet", "control_net")):
                continue
            key = (category, path)
            if key not in found:
                standard = by_path.get(key, {})
                found[key] = {"category": category, "relative_path": path, "url": standard.get("url", ""), "source": "scan", "enabled": True, "references": []}
                if standard.get("hash_type", "").lower() == "sha256":
                    found[key]["sha256"] = standard.get("hash", "")
            found[key]["references"].append({"node_id": str(node.get("node_id", "")), "input_name": input_name})
            if not category:
                warnings.append(f"{node_type}.{input_name}：{path} 的保存类别需要手动确认")
        if node_type not in LOADERS and any(word in node_type.lower() for word in ("loader", "lora", "model")):
            if not any(ref["node_id"] == str(node.get("node_id", "")) for row in found.values() for ref in row["references"]):
                warnings.append(f"{node_type}：未识别到静态模型文件，可手动补充")
    return list(found.values()), list(dict.fromkeys(warnings))


def refresh_categories(names):
    for name in set(names):
        folder_paths.filename_list_cache.pop(name, None)
        folder_paths.cache_helper.cache.pop(name, None)
