import asyncio
import os
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
import folder_paths
import nodes
from server import PromptServer

from .download import DownloadManager
from .manifest import LOADERS, MANIFEST_NODE, VAE_APPROX_MODELS, categories, check_models, read_manifest, refresh_categories, scan_nodes
from .modelscope import import_models


manager = DownloadManager()


def same_origin(request):
    if request.headers.get("Sec-Fetch-Site") == "cross-site":
        raise web.HTTPForbidden(text="不允许跨站请求")
    origin = request.headers.get("Origin")
    if origin and urlsplit(origin).netloc.lower() != request.host.lower():
        raise web.HTTPForbidden(text="请求来源与 ComfyUI 地址不一致")


async def body(request):
    same_origin(request)
    data = await request.json()
    if not isinstance(data, dict):
        raise ValueError("请求内容必须是 JSON 对象")
    return data


def prompt_nodes(prompt, targets=None):
    roots = targets if targets is not None else [
        node_id for node_id, node in prompt.items()
        if getattr(nodes.NODE_CLASS_MAPPINGS.get(node.get("class_type")), "OUTPUT_NODE", False)
    ]
    pending = [str(node_id) for node_id in roots]
    visited = set()
    while pending:
        node_id = pending.pop()
        if node_id in visited or node_id not in prompt:
            continue
        visited.add(node_id)
        for value in prompt[node_id].get("inputs", {}).values():
            if isinstance(value, list) and len(value) == 2 and str(value[0]) in prompt and isinstance(value[1], int):
                pending.append(str(value[0]))
    return [{"node_id": node_id, "node_type": prompt[node_id].get("class_type"), "inputs": prompt[node_id].get("inputs", {})} for node_id in visited]


def workflow_nodes(workflow):
    yield from workflow.get("nodes", [])
    for subgraph in workflow.get("definitions", {}).get("subgraphs", []):
        yield from workflow_nodes(subgraph)


def model_key(model):
    return folder_paths.map_legacy(str(model.get("category", ""))), os.path.normcase(str(model.get("relative_path", "")).replace("\\", "/"))


def request_models(data):
    workflow = data.get("extra_data", {}).get("extra_pnginfo", {}).get("workflow") or {}
    manifests = []
    if "model_manifest" in data:
        manifests.append(data["model_manifest"])
    all_nodes = list(workflow_nodes(workflow))
    for node in all_nodes:
        properties = node.get("properties", {})
        if node.get("type") == MANIFEST_NODE and node.get("mode", 0) not in (2, 4) and properties.get("gw_manifest_enabled", True):
            manifests.append(properties.get("gw_model_manifest"))
    prompt = data.get("prompt")
    if isinstance(prompt, dict):
        for node in prompt.values():
            if node.get("class_type") == MANIFEST_NODE:
                manifests.append(node.get("inputs", {}).get("manifest"))
    if not manifests:
        return None
    manifests = [read_manifest(value) for value in manifests]
    manifests = [value for value in manifests if value.get("enabled", True)]
    if not manifests:
        return None
    saved = []
    for manifest in manifests:
        saved.extend(manifest["models"])
    if not isinstance(prompt, dict):
        raise ValueError("prompt 必须是 API 格式的节点对象")
    metadata = list(workflow.get("models") or [])
    for node in all_nodes:
        metadata.extend(node.get("properties", {}).get("models") or [])
    scanned, _ = scan_nodes(prompt_nodes(prompt, data.get("partial_execution_targets")), metadata)
    active = []
    for model in scanned:
        if not model["category"]:
            candidates = {model_key(item)[0] for item in saved if model_key(item)[1] == model_key(model)[1]}
            if len(candidates) == 1:
                model["category"] = candidates.pop()
        previous = [item for item in saved if model_key(item) == model_key(model)]
        active.extend([item for item in previous if item.get("enabled", True)] if previous else [model])
    active.extend(item for item in saved if item.get("required") is True and item.get("enabled", True))
    return active


def download_specs(models, root_indices=None):
    results = check_models(models, root_indices)
    errors = [f"{item['relative_path']}：{item['error']}" for item in results if item["status"] in ("no_url", "invalid")]
    if errors:
        raise ValueError("\n".join(errors))
    return [item for item in results if item["status"] == "missing"]


def prompt_error(message, status=400):
    return web.json_response({"error": {"type": "gw_model_preparation_failed", "message": "模型准备失败", "details": message, "extra_info": {}}, "node_errors": {}}, status=status)


@web.middleware
async def complete_models_before_prompt(request, handler):
    if request.method != "POST" or request.path not in ("/prompt", "/api/prompt"):
        return await handler(request)
    data = await request.json()
    if not isinstance(data, dict):
        return await handler(request)
    try:
        models = await asyncio.to_thread(request_models, data)
        if models is not None:
            same_origin(request)
            root_indices = data.get("root_indices")
            specs = await asyncio.to_thread(download_specs, models, root_indices)
            if specs:
                job = manager.start(specs)
                await asyncio.shield(manager.jobs[job["id"]]["task"])
                result = manager.snapshot(job["id"])
                refresh_categories(item["category"] for item in result["files"])
                if result["status"] != "complete":
                    failed = next((item for item in result["files"] if item["status"] == "failed"), None)
                    message = (f"{failed['relative_path']}：" if failed else "") + result.get("error", "模型下载已取消")
                    return prompt_error(message, 409 if result["status"] == "cancelled" else 502)
                if await asyncio.to_thread(download_specs, models, root_indices):
                    raise ValueError("模型下载后仍有缺失文件，请重试")
    except (ValueError, TypeError, AttributeError, OSError) as error:
        return prompt_error(str(error))
    return await handler(request)


def register_routes():
    routes = PromptServer.instance.routes
    PromptServer.instance.app.middlewares.append(complete_models_before_prompt)

    @routes.post("/editing_gw/models/scan")
    async def scan(request):
        try:
            data = await body(request)
            items = data.get("nodes", [])
            if "prompt" in data:
                items = prompt_nodes(data["prompt"], data.get("targets"))
            if not isinstance(items, list) or len(items) > 20000:
                raise ValueError("节点列表无效或超过 20000 条")
            models, warnings = await asyncio.to_thread(scan_nodes, items, data.get("metadata", []))
            return web.json_response({"models": models, "warnings": warnings, "categories": categories(), "folders": {name: folder_paths.get_folder_paths(name) for name in categories()}, "loaders": LOADERS, "vae_approx_models": VAE_APPROX_MODELS, "separator": os.sep})
        except (ValueError, TypeError, AttributeError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.post("/editing_gw/models/import")
    async def import_repository(request):
        try:
            data = await body(request)
            result = await import_models(data.get("url"), data.get("category", ""))
            return web.json_response({**result, "categories": categories(), "folders": {name: folder_paths.get_folder_paths(name) for name in categories()}})
        except (ValueError, TypeError, AttributeError) as error:
            return web.json_response({"error": str(error)}, status=400)
        except (aiohttp.ClientError, asyncio.TimeoutError) as error:
            return web.json_response({"error": f"无法读取魔搭目录，请检查网络后重试：{error}"}, status=502)

    @routes.post("/editing_gw/models/check")
    async def check(request):
        try:
            data = await body(request)
            results = await asyncio.to_thread(check_models, data.get("models", []), data.get("root_indices"), data.get("verify_sha256") is True)
            return web.json_response({"models": results, "categories": categories()})
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.post("/editing_gw/downloads")
    async def start(request):
        try:
            data = await body(request)
            specs = await asyncio.to_thread(download_specs, data.get("models", []), data.get("root_indices"))
            return web.json_response(manager.start(specs))
        except (ValueError, OSError) as error:
            return web.json_response({"error": str(error)}, status=400)

    @routes.get("/editing_gw/downloads/{job_id}")
    async def status(request):
        same_origin(request)
        try:
            result = manager.snapshot(request.match_info["job_id"])
            if result["status"] == "complete":
                refresh_categories(item["category"] for item in result["files"])
            return web.json_response(result)
        except KeyError:
            return web.json_response({"error": "下载任务不存在或已过期"}, status=404)

    @routes.post("/editing_gw/downloads/{job_id}/cancel")
    async def cancel(request):
        same_origin(request)
        try:
            return web.json_response(manager.cancel(request.match_info["job_id"]))
        except KeyError:
            return web.json_response({"error": "下载任务不存在或已过期"}, status=404)
