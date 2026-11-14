import re
from pathlib import PurePosixPath
from urllib.parse import quote, unquote, urlsplit

import aiohttp
import folder_paths

from .download import PublicResolver
from .manifest import MODEL_EXTENSIONS, categories, relative_path


WEIGHT_EXTENSIONS = MODEL_EXTENSIONS - {".json", ".txt", ".vocab", ".yaml", ".yml"}


def repository_url(value):
    if not isinstance(value, str):
        raise ValueError("请填写魔搭模型仓库或目录链接")
    url = urlsplit(value.strip())
    if url.scheme not in ("http", "https") or url.hostname not in ("modelscope.cn", "www.modelscope.cn") or url.username is not None or url.password is not None or url.port not in (None, 80, 443):
        raise ValueError("请填写 modelscope.cn 的模型仓库或目录链接")
    parts = url.path.strip("/").split("/")
    if len(parts) < 3 or parts[0] != "models" or any(not re.fullmatch(r"[\w.-]+", part) or part in (".", "..") for part in parts[1:3]):
        raise ValueError("魔搭链接格式应为 /models/作者/仓库/tree/版本/目录")
    revision, root = "master", ""
    if len(parts) > 3:
        if len(parts) < 5 or parts[3] != "tree":
            raise ValueError("请使用魔搭仓库首页或 tree 目录链接")
        revision = unquote(parts[4])
        if not revision or any(ord(char) < 32 for char in revision):
            raise ValueError("魔搭版本不能为空或包含控制字符")
        root = unquote("/".join(parts[5:]))
        if root and (root.startswith("/") or "\\" in root or any(part in ("", ".", "..") for part in root.split("/"))):
            raise ValueError("魔搭目录路径无效")
    return "/".join(parts[1:3]), revision, root


async def import_models(value, fallback_category=""):
    repository, revision, root = repository_url(value)
    allowed = categories()
    if not isinstance(fallback_category, str) or (fallback_category and fallback_category not in allowed):
        raise ValueError("请选择有效的模型保存类别")
    timeout = aiohttp.ClientTimeout(total=60, connect=15)
    connector = aiohttp.TCPConnector(resolver=PublicResolver())
    async with aiohttp.ClientSession(connector=connector, timeout=timeout, trust_env=False) as session:
        async with session.get(f"https://modelscope.cn/api/v1/models/{repository}/repo/files", params={"Revision": revision, "Root": root, "Recursive": "true"}, allow_redirects=False) as response:
            if response.status != 200:
                raise ValueError(f"读取魔搭目录失败，HTTP {response.status}；请检查链接及公开访问权限")
            data = await response.json()
    if data.get("Code") != 200:
        raise ValueError(f"读取魔搭目录失败：{data.get('Message') or '仓库或版本不存在'}")
    files = data.get("Data", {}).get("Files")
    if not isinstance(files, list):
        raise ValueError("魔搭未返回有效的文件列表")
    models = {}
    for item in files:
        if item.get("Type") != "blob":
            continue
        path = item.get("Path", "")
        if PurePosixPath(path).suffix.lower() not in WEIGHT_EXTENSIONS or (root and not path.startswith(root + "/")):
            continue
        path = relative_path(path)
        parts = path.split("/")
        category = ""
        model_path = path[len(root) + 1:] if root else path
        for index, part in enumerate(parts[:-1]):
            name = folder_paths.map_legacy(part)
            if name in allowed:
                category, model_path = name, "/".join(parts[index + 1:])
                break
        category = category or fallback_category
        sha256 = item.get("Sha256") or ""
        if not isinstance(sha256, str) or (sha256 and not re.fullmatch(r"[0-9a-fA-F]{64}", sha256)):
            raise ValueError(f"魔搭返回的 SHA256 无效：{path}")
        size = item.get("Size")
        download_url = f"https://modelscope.cn/models/{repository}/resolve/{quote(revision, safe='')}/{quote(path, safe='/')}"
        previous = models.get((category, model_path))
        if previous and previous["url"] != download_url:
            raise ValueError(f"多个仓库文件对应同一保存位置：{category}/{model_path}，请改用具体的子目录链接")
        models[(category, model_path)] = {
            "category": category, "relative_path": model_path,
            "url": download_url,
            "sha256": sha256.lower(), "size_bytes": size if isinstance(size, int) and size > 0 else None,
            "source": "modelscope", "enabled": True, "required": False, "references": [],
        }
        if len(models) > 5000:
            raise ValueError("目录超过 5000 个模型文件，请改用更具体的子目录链接")
    if not models:
        raise ValueError("此链接目录中没有支持的模型文件，请检查目录及版本")
    unknown = sum(not model["category"] for model in models.values())
    return {"models": list(models.values()), "warnings": [f"{unknown} 个模型无法识别保存类别，请在表格中选择。"] if unknown else []}
