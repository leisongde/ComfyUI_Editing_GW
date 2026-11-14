import asyncio
import hashlib
import ipaddress
import os
import time
import uuid

import aiohttp
from aiohttp.resolver import ThreadedResolver
from yarl import URL

from .manifest import contained_path


def validate_url(value):
    url = URL(value)
    if url.scheme not in ("http", "https") or not url.host or url.user is not None or url.password is not None:
        raise ValueError("下载地址必须是不含账号密码的 HTTP(S) 文件直链")
    if url.fragment:
        raise ValueError("下载地址不能包含 # 片段，请使用文件直链")
    try:
        address = ipaddress.ip_address(url.host)
    except ValueError:
        address = None
    if address is not None and (not address.is_global or address.is_multicast):
        raise ValueError("下载地址不能指向本机或私有网络")
    if url.host.lower() == "localhost" or url.host.lower().endswith((".localhost", ".local")):
        raise ValueError("下载地址不能指向本机或私有网络")
    return url


class PublicResolver(ThreadedResolver):
    async def resolve(self, host, port=0, family=0):
        addresses = await super().resolve(host, port, family)
        if not addresses or any(not ipaddress.ip_address(item["host"]).is_global or ipaddress.ip_address(item["host"]).is_multicast for item in addresses):
            raise ValueError("下载地址解析到了本机或私有网络")
        return addresses


def authorization(host):
    if host == "huggingface.co":
        token = os.environ.get("HF_TOKEN", "")
    elif host == "civitai.com":
        token = os.environ.get("CIVITAI_API_TOKEN", "")
    else:
        token = ""
    return {"Authorization": f"Bearer {token}"} if token else {}


async def download_file(spec, progress):
    url = validate_url(spec["url"])
    initial_origin = url.origin()
    target = spec["target_path"]
    root = spec["root"]
    contained_path(root, spec["relative_path"])
    os.makedirs(os.path.dirname(target), exist_ok=True)
    contained_path(root, spec["relative_path"])
    temporary = target + "." + uuid.uuid4().hex + ".part"
    timeout = aiohttp.ClientTimeout(total=None, connect=60, sock_read=120)
    connector = aiohttp.TCPConnector(resolver=PublicResolver(), limit=2)
    try:
        async with aiohttp.ClientSession(connector=connector, timeout=timeout, auto_decompress=False, trust_env=False) as session:
            for redirect in range(6):
                headers = {"Accept-Encoding": "identity", "User-Agent": "ComfyUI-Editing-GW/1.0"}
                if url.origin() == initial_origin and url.scheme == "https" and url.port == 443:
                    headers.update(authorization(url.host))
                async with session.get(url, headers=headers, allow_redirects=False) as response:
                    if response.status in (301, 302, 303, 307, 308):
                        location = response.headers.get("Location")
                        if not location or redirect == 5:
                            raise ValueError("下载地址重定向过多或缺少目标地址")
                        url = validate_url(str(url.join(URL(location))))
                        continue
                    if response.status != 200:
                        hint = "；请检查本机 HF_TOKEN / CIVITAI_API_TOKEN 或下载权限" if response.status in (401, 403) else ""
                        raise ValueError(f"下载失败，HTTP {response.status}{hint}")
                    content_type = response.headers.get("Content-Type", "").split(";", 1)[0].lower()
                    if content_type in ("text/html", "application/xhtml+xml"):
                        raise ValueError("下载地址返回了网页，请填写模型文件直链")
                    if (content_type == "application/json" or content_type.endswith("+json")) and not target.lower().endswith(".json"):
                        raise ValueError("下载地址返回了 JSON 信息，请使用模型文件下载接口")
                    total = response.content_length
                    expected = spec["size_bytes"]
                    if expected and total is not None and expected != total:
                        raise ValueError("服务器返回的文件大小与清单不一致")
                    progress.update(status="downloading", total=total or expected, downloaded=0)
                    digest = hashlib.sha256() if spec["sha256"] else None
                    started = time.monotonic()
                    with open(temporary, "xb") as output:
                        prefix = b""
                        async for block in response.content.iter_chunked(1024 * 1024):
                            prefix += block[:max(0, 512 - len(prefix))]
                            if prefix.lstrip().lower().startswith((b"<!doctype html", b"<html")):
                                raise ValueError("下载地址返回了 HTML 页面")
                            output.write(block)
                            if digest:
                                digest.update(block)
                            progress["downloaded"] += len(block)
                            progress["speed"] = progress["downloaded"] / max(time.monotonic() - started, 0.01)
                            if expected and progress["downloaded"] > expected:
                                raise ValueError("下载文件超过清单中的预期大小")
                    size = progress["downloaded"]
                    if not size or (expected and size != expected) or (total is not None and size != total):
                        raise ValueError("下载文件为空或大小不完整")
                    if digest and digest.hexdigest() != spec["sha256"]:
                        raise ValueError("SHA256 校验失败")
                    contained_path(root, spec["relative_path"])
                    if os.name == "nt":
                        os.rename(temporary, target)
                    else:
                        os.link(temporary, target)
                        os.unlink(temporary)
                    progress.update(status="complete", speed=0)
                    return
    finally:
        if os.path.isfile(temporary):
            os.unlink(temporary)


class DownloadManager:
    def __init__(self):
        self.jobs = {}
        self.claims = {}
        self.semaphore = asyncio.Semaphore(1)

    def start(self, specs):
        for spec in specs:
            validate_url(spec["url"])
            key = os.path.normcase(os.path.realpath(spec["target_path"]))
            signature = (spec["url"], spec["sha256"], spec["size_bytes"])
            if key in self.claims and self.claims[key]["signature"] != signature:
                raise ValueError(f"已有其他任务下载同一路径的不同文件：{spec['relative_path']}")
        job_id = uuid.uuid4().hex
        job = {"id": job_id, "status": "queued", "_claim_keys": [], "files": [
            {"category": spec["category"], "relative_path": spec["relative_path"], "status": "queued", "downloaded": 0, "total": spec["size_bytes"], "speed": 0}
            for spec in specs
        ]}
        for spec in specs:
            key = os.path.normcase(os.path.realpath(spec["target_path"]))
            claim = self.claims.setdefault(key, {"signature": (spec["url"], spec["sha256"], spec["size_bytes"]), "count": 0})
            claim["count"] += 1
            job["_claim_keys"].append(key)
        self.jobs[job_id] = job
        job["task"] = asyncio.create_task(self._run(job, specs))
        return self.snapshot(job_id)

    def snapshot(self, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        return {key: value for key, value in job.items() if key != "task" and not key.startswith("_")}

    def cancel(self, job_id):
        job = self.jobs.get(job_id)
        if job is None:
            raise KeyError(job_id)
        if job["status"] in ("queued", "running"):
            running = job["status"] == "running"
            job["status"] = "cancelling"
            if running:
                job["task"].cancel()
        return self.snapshot(job_id)

    async def _run(self, job, specs):
        current = None
        try:
            if job["status"] == "cancelling":
                raise asyncio.CancelledError
            job["status"] = "running"
            for spec, current in zip(specs, job["files"]):
                async with self.semaphore:
                    contained_path(spec["root"], spec["relative_path"])
                    if os.path.isfile(spec["target_path"]):
                        size = os.path.getsize(spec["target_path"])
                        if not size or (spec["size_bytes"] and size != spec["size_bytes"]):
                            raise ValueError("目标文件已存在但大小不符，请移走后重试")
                        current.update(status="exists", downloaded=size, total=size)
                    else:
                        await download_file(spec, current)
            job["status"] = "complete"
        except asyncio.CancelledError:
            job["status"] = "cancelled"
            if current:
                current["status"] = "cancelled"
            for item in job["files"]:
                if item["status"] == "queued":
                    item["status"] = "cancelled"
        except (ValueError, OSError, aiohttp.ClientError, asyncio.TimeoutError) as error:
            if isinstance(error, aiohttp.ClientError):
                message = "网络连接失败或下载中断，请检查地址和网络后重试"
            elif isinstance(error, asyncio.TimeoutError):
                message = "下载连接超时，请重试"
            else:
                message = str(error)
            job.update(status="failed", error=message)
            if current:
                current.update(status="failed", error=message)
        finally:
            for key in job.pop("_claim_keys"):
                claim = self.claims[key]
                claim["count"] -= 1
                if not claim["count"]:
                    del self.claims[key]
            asyncio.get_running_loop().call_later(900, self.jobs.pop, job["id"], None)
