import asyncio
import hashlib
import importlib
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import types
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from aiohttp import web
from aiohttp.resolver import ThreadedResolver
from aiohttp.test_utils import TestClient, TestServer


PLUGIN = Path(__file__).resolve().parents[1]
COMFYUI = Path(os.environ.get("COMFYUI_PATH", str(PLUGIN.parents[1]))).expanduser().resolve()
if not (COMFYUI / "folder_paths.py").is_file():
    raise RuntimeError("请设置 COMFYUI_PATH 为 ComfyUI 源码根目录，或将插件放在 ComfyUI/custom_nodes 中运行测试")
sys.path.insert(0, str(COMFYUI))
import folder_paths

package = types.ModuleType("gw_test_package")
package.__path__ = [str(PLUGIN)]
sys.modules[package.__name__] = package
manifest = importlib.import_module("gw_test_package.manifest")
download = importlib.import_module("gw_test_package.download")
model_node = importlib.import_module("gw_test_package.model_node")
modelscope = importlib.import_module("gw_test_package.modelscope")


class ModelPaths(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.folders = {name: ([str(self.root / name)], {".safetensors", ".gguf"}) for name in ("checkpoints", "loras", "vae", "diffusion_models", "text_encoders")}
        self.patch = patch.object(folder_paths, "folder_names_and_paths", self.folders)
        self.patch.start()
        folder_paths.filename_list_cache.clear()
        folder_paths.cache_helper.clear()
        for roots, _ in self.folders.values():
            Path(roots[0]).mkdir()

    def tearDown(self):
        self.patch.stop()
        folder_paths.filename_list_cache.clear()
        self.temp.cleanup()

    def model(self, **changes):
        return {"category": "loras", "relative_path": "styles/test.safetensors", "url": "https://example.com/test.safetensors", **changes}

    def test_path_boundaries_and_extensions(self):
        for value in ("../escape.safetensors", "D:/escape.safetensors", "\\\\server\\file.safetensors", "/tmp/a.safetensors", "x/../../a.safetensors", "CON.safetensors", "test.safetensors:stream", "a./b.safetensors", "foo//bar.safetensors", "node.py"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                manifest.normalize_model(self.model(relative_path=value))
        self.assertEqual(manifest.normalize_model(self.model(relative_path="styles\\test.safetensors"))["relative_path"], "styles/test.safetensors")
        with self.assertRaises(ValueError):
            manifest.normalize_model(self.model(category="custom_nodes"))

    def test_missing_existing_extra_root_and_explicit_hash_check(self):
        extra = self.root / "extra"
        extra.mkdir()
        self.folders["loras"][0].append(str(extra))
        item = self.model(size_bytes=4, sha256=hashlib.sha256(b"data").hexdigest())
        self.assertEqual(manifest.check_models([item], {"loras": 1})[0]["root"], str(extra))
        path = extra / "styles/test.safetensors"
        path.parent.mkdir()
        path.write_bytes(b"data")
        checked = manifest.check_models([item], verify_sha256=True)[0]
        self.assertEqual(checked["status"], "exists")
        self.assertTrue(checked["hash_verified"])
        self.assertEqual(checked["loader_value"], os.path.join("styles", "test.safetensors"))
        path.write_bytes(b"oops")
        self.assertEqual(manifest.check_models([item])[0]["status"], "exists")
        self.assertEqual(manifest.check_models([item], verify_sha256=True)[0]["status"], "invalid")
        path.write_bytes(b"")
        self.assertEqual(manifest.check_models([item])[0]["status"], "invalid")

    def test_no_url_duplicates_and_conflicts(self):
        self.assertEqual(manifest.check_models([self.model(url="")])[0]["status"], "no_url")
        self.assertEqual(len(manifest.check_models([self.model(), self.model()])), 1)
        self.assertEqual(manifest.check_models([self.model(enabled=False)]), [])
        with self.assertRaises(ValueError):
            manifest.check_models([self.model(), self.model(url="https://example.org/other")])

    def test_scan_only_used_values_and_keep_references(self):
        nodes = [
            {"node_id": "1", "node_type": "UNETLoader", "inputs": {"unet_name": "flux\\model.safetensors", "weight_dtype": "default"}},
            {"node_id": "7:2", "node_type": "UNETLoader", "inputs": {"unet_name": "flux/model.safetensors"}},
            {"node_id": "3", "node_type": "VAELoader", "inputs": {"vae_name": "taesd"}},
            {"node_id": "4", "node_type": "UnknownLoader", "inputs": {"model_name": "missing.gguf"}},
        ]
        found, warnings = manifest.scan_nodes(nodes, [{"name": "flux/model.safetensors", "directory": "diffusion_models", "url": "https://example.com/model"}])
        self.assertEqual(len(found), 2)
        self.assertEqual(len(found[0]["references"]), 2)
        self.assertEqual(found[0]["url"], "https://example.com/model")
        self.assertEqual(found[1]["category"], "")
        self.assertTrue(warnings)

    def test_new_subdirectory_invalidates_model_list(self):
        self.assertEqual(folder_paths.get_filename_list("loras"), [])
        path = self.root / "loras/styles/test.safetensors"
        path.parent.mkdir()
        path.write_bytes(b"test")
        manifest.refresh_categories(["loras"])
        self.assertIn(os.path.join("styles", "test.safetensors"), folder_paths.get_filename_list("loras"))

    def test_special_vae_directory_and_split_vae_warning(self):
        found, warnings = manifest.scan_nodes([
            {"node_id": "1", "node_type": "VAELoader", "inputs": {"vae_name": "taehv.pth"}},
            {"node_id": "2", "node_type": "VAELoader", "inputs": {"vae_name": "taesd"}},
        ])
        self.assertEqual(found[0]["category"], "vae_approx")
        self.assertTrue(any("vae_approx" in warning for warning in warnings))

    def test_selection_node_outputs_native_path_and_rejects_unregistered_values(self):
        item = self.model()
        catalog = json.dumps({"version": 1, "models": [item]})
        node = model_node.ModelManifest()
        with self.assertRaisesRegex(ValueError, "尚未就绪"):
            node.select_model("loras/styles/test.safetensors", catalog)
        path = self.root / "loras/styles/test.safetensors"
        path.parent.mkdir()
        path.write_bytes(b"data")
        self.assertEqual(node.select_model("loras/styles/test.safetensors", catalog), (os.path.join("styles", "test.safetensors"),))
        with self.assertRaisesRegex(ValueError, "未登记"):
            node.select_model("loras/unregistered.safetensors", catalog)
        with self.assertRaisesRegex(ValueError, "停用"):
            node.select_model("loras/styles/test.safetensors", {"version": 1, "models": [self.model(enabled=False)]})

    def test_symlink_cannot_escape_model_root(self):
        outside = self.root / "outside"
        outside.mkdir()
        try:
            (self.root / "loras/link").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("Current Windows user cannot create symlinks")
        with self.assertRaises(ValueError):
            manifest.check_models([self.model(relative_path="link/test.safetensors")])


class ModelScope(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.response = MagicMock(status=200)
        self.response.__aenter__.return_value = self.response
        self.response.json = AsyncMock()
        self.session = MagicMock()
        self.session.__aenter__.return_value = self.session
        self.session.get.return_value = self.response
        self.client_patch = patch.object(modelscope.aiohttp, "ClientSession", return_value=self.session)
        self.connector_patch = patch.object(modelscope.aiohttp, "TCPConnector")
        self.client_patch.start()
        self.connector_patch.start()

    async def asyncTearDown(self):
        self.client_patch.stop()
        self.connector_patch.stop()

    def files(self, *paths):
        self.response.json.return_value = {"Code": 200, "Data": {"Files": [
            {"Type": "blob", "Path": path, "Sha256": "A" * 64, "Size": 123} for path in paths
        ]}}

    async def test_recursive_directory_import_metadata_and_file_scope(self):
        self.files("diffusion_models/a.safetensors", "diffusion_models/nested/b fp8.gguf", "diffusion_models/a.safetensors", "diffusion_models/config.json", "text_encoders/outside.safetensors")
        result = await modelscope.import_models("https://modelscope.cn/models/Comfy-Org/MiniMax-H3/tree/master/diffusion_models")
        self.assertEqual([model["relative_path"] for model in result["models"]], ["a.safetensors", "nested/b fp8.gguf"])
        first, second = result["models"]
        self.assertEqual(first["category"], "diffusion_models")
        self.assertEqual(first["sha256"], "a" * 64)
        self.assertEqual(first["size_bytes"], 123)
        self.assertFalse(first["required"])
        self.assertIn("/resolve/master/diffusion_models/nested/b%20fp8.gguf", second["url"])
        self.assertEqual(self.session.get.call_count, 1)
        self.assertEqual(self.session.get.call_args.kwargs["params"], {"Revision": "master", "Root": "diffusion_models", "Recursive": "true"})
        self.assertFalse(self.session.get.call_args.kwargs["allow_redirects"])

    async def test_repository_root_infers_categories_and_keeps_unknown_paths(self):
        self.files("models/unet/nested/a.safetensors", "text_encoders/b.safetensors", "vae/c.safetensors", "weights/d.gguf")
        result = await modelscope.import_models("https://modelscope.cn/models/Comfy-Org/MiniMax-H3")
        self.assertEqual([model["category"] for model in result["models"]], ["diffusion_models", "text_encoders", "vae", ""])
        self.assertEqual(result["models"][0]["relative_path"], "nested/a.safetensors")
        self.assertEqual(result["models"][-1]["relative_path"], "weights/d.gguf")
        self.assertTrue(result["warnings"])
        result = await modelscope.import_models("https://modelscope.cn/models/Comfy-Org/MiniMax-H3/tree/v1/weights", "loras")
        self.assertEqual(result["models"][0]["category"], "loras")
        self.assertEqual(result["models"][0]["relative_path"], "d.gguf")
        self.assertIn("/resolve/v1/weights/d.gguf", result["models"][0]["url"])

    async def test_rejects_invalid_links_categories_and_external_paths(self):
        for url in ("https://example.com/models/A/B", "https://modelscope.cn.evil.example/models/A/B", "https://user:password@modelscope.cn/models/A/B", "https://modelscope.cn:8080/models/A/B", "https://modelscope.cn/models/A/B/tree/master/../weights", "https://modelscope.cn/models/A/B/blob/master/a.safetensors"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                await modelscope.import_models(url)
        with self.assertRaises(ValueError):
            await modelscope.import_models("https://modelscope.cn/models/A/B", "custom_nodes")
        self.session.get.assert_not_called()
        self.files("diffusion_models/../../escape.safetensors")
        with self.assertRaisesRegex(ValueError, "相对路径"):
            await modelscope.import_models("https://modelscope.cn/models/A/B")

    async def test_errors_and_conflicting_target_paths_are_not_partial_success(self):
        self.files("README.md", "configuration.json")
        with self.assertRaisesRegex(ValueError, "没有支持"):
            await modelscope.import_models("https://modelscope.cn/models/A/B")
        self.response.status = 404
        with self.assertRaisesRegex(ValueError, "HTTP 404"):
            await modelscope.import_models("https://modelscope.cn/models/A/B")
        self.response.status = 200
        self.response.json.return_value = {"Code": 404, "Message": "not found"}
        with self.assertRaisesRegex(ValueError, "not found"):
            await modelscope.import_models("https://modelscope.cn/models/A/B")
        self.files("diffusion_models/a.safetensors")
        self.response.json.return_value["Data"]["Files"][0]["Sha256"] = "invalid"
        with self.assertRaisesRegex(ValueError, "SHA256"):
            await modelscope.import_models("https://modelscope.cn/models/A/B")
        self.files("one/loras/a.safetensors", "two/loras/a.safetensors")
        with self.assertRaisesRegex(ValueError, "同一保存位置"):
            await modelscope.import_models("https://modelscope.cn/models/A/B")


class LoopbackTestResolver(ThreadedResolver):
    async def resolve(self, host, port=0, family=0):
        return [{"hostname": host, "host": "127.0.0.1", "port": port, "family": socket.AF_INET, "proto": 0, "flags": 0}]


class Downloads(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.hits = 0
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        application = web.Application()
        application.router.add_get("/{mode}", self.serve)
        self.server = TestServer(application)
        await self.server.start_server()
        self.resolver = patch.object(download, "PublicResolver", LoopbackTestResolver)
        self.resolver.start()
        self.manager = download.DownloadManager()

    async def asyncTearDown(self):
        self.release.set()
        for job in self.manager.jobs.values():
            if not job["task"].done():
                job["task"].cancel()
        await asyncio.gather(*(job["task"] for job in self.manager.jobs.values()), return_exceptions=True)
        self.resolver.stop()
        await self.server.close()
        self.temp.cleanup()

    async def serve(self, request):
        self.hits += 1
        mode = request.match_info["mode"]
        if mode == "html":
            return web.Response(text="<html>login</html>", content_type="text/html")
        if mode == "json":
            return web.json_response({"error": "This is metadata, not a model"})
        if mode == "redirect":
            raise web.HTTPFound("http://127.0.0.1/private")
        if mode == "404":
            raise web.HTTPNotFound()
        if mode == "slow":
            response = web.StreamResponse()
            await response.prepare(request)
            await response.write(b"first")
            self.started.set()
            await self.release.wait()
            return response
        if mode == "split_html":
            response = web.StreamResponse(headers={"Content-Type": "application/octet-stream"})
            await response.prepare(request)
            await response.write(b"<")
            await asyncio.sleep(0.01)
            await response.write(b"html>login</html>")
            return response
        return web.Response(body=b"model-data", content_type="application/octet-stream")

    def spec(self, mode="file", **changes):
        return {"category": "loras", "relative_path": "sub/model.safetensors", "root": str(self.root), "target_path": str(self.root / "sub/model.safetensors"), "url": str(self.server.make_url("/" + mode).with_host("models.test")), "sha256": "", "size_bytes": None, **changes}

    async def finish(self, job):
        await asyncio.wait_for(self.manager.jobs[job["id"]]["task"], 5)
        return self.manager.snapshot(job["id"])

    async def test_real_stream_hash_atomic_install_and_existing_skip(self):
        spec = self.spec(sha256=hashlib.sha256(b"model-data").hexdigest(), size_bytes=10)
        result = await self.finish(self.manager.start([spec]))
        self.assertEqual(result["status"], "complete")
        self.assertEqual(Path(spec["target_path"]).read_bytes(), b"model-data")
        self.assertFalse(list(self.root.rglob("*.part")))
        result = await self.finish(self.manager.start([spec]))
        self.assertEqual(result["files"][0]["status"], "exists")
        self.assertEqual(self.hits, 1)

    async def test_failed_files_are_never_installed(self):
        for mode, changes in [("html", {}), ("split_html", {}), ("json", {}), ("404", {}), ("redirect", {}), ("file", {"sha256": "0" * 64}), ("file", {"size_bytes": 11})]:
            with self.subTest(mode=mode, changes=changes):
                result = await self.finish(self.manager.start([self.spec(mode, **changes)]))
                self.assertEqual(result["status"], "failed")
                self.assertFalse(Path(self.spec()["target_path"]).exists())
                self.assertFalse(list(self.root.rglob("*.part")))
                self.assertEqual(self.manager.claims, {})

    async def test_deduplicate_simultaneous_jobs_and_reject_conflicts(self):
        first = self.manager.start([self.spec()])
        second = self.manager.start([self.spec()])
        with self.assertRaises(ValueError):
            self.manager.start([self.spec(sha256="1" * 64)])
        await self.finish(first)
        await self.finish(second)
        self.assertEqual(self.hits, 1)
        self.assertEqual(self.manager.claims, {})

    async def test_cancel_before_start_releases_claims(self):
        job = self.manager.start([self.spec()])
        self.manager.cancel(job["id"])
        result = await self.finish(job)
        self.assertEqual(result["status"], "cancelled")
        self.assertEqual(self.manager.claims, {})
        self.assertEqual(self.hits, 0)

    async def test_cancel_stream_removes_partial_file(self):
        job = self.manager.start([self.spec("slow")])
        await asyncio.wait_for(self.started.wait(), 5)
        self.manager.cancel(job["id"])
        result = await self.finish(job)
        self.assertEqual(result["status"], "cancelled")
        self.assertFalse(Path(self.spec()["target_path"]).exists())
        self.assertFalse(list(self.root.rglob("*.part")))

    def test_url_boundary(self):
        for url in ("file:///tmp/model", "http://localhost/model", "http://127.0.0.1/model", "http://192.168.1.1/model", "http://[::1]/model", "https://user:password@example.com/model", "https://example.com/model#fragment", "http://224.0.0.1/model"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                download.validate_url(url)

    async def test_credentials_stay_on_default_https_origin(self):
        async def chunks(_size):
            yield b"model-data"

        for initial, destination, expected in (
            ("https://huggingface.co/model", "https://huggingface.co/other", [True, True]),
            ("https://huggingface.co/model", "https://huggingface.co:8443/other", [True, False]),
            ("https://huggingface.co/model", "https://cdn.example.com/model", [True, False]),
            ("http://huggingface.co/model", "https://huggingface.co/model", [False, False]),
            ("https://huggingface.co:8443/model", None, [False]),
            ("https://civitai.com/model", "https://civitai.com:8443/model", [True, False]),
        ):
            with self.subTest(initial=initial, destination=destination):
                response = MagicMock(status=200, content_length=10)
                response.headers = {"Content-Type": "application/octet-stream"}
                response.__aenter__.return_value = response
                response.content.iter_chunked = chunks
                session = MagicMock()
                session.__aenter__.return_value = session
                responses = [response]
                if destination:
                    redirect = MagicMock(status=302)
                    redirect.headers = {"Location": destination}
                    redirect.__aenter__.return_value = redirect
                    responses.insert(0, redirect)
                session.get.side_effect = responses
                spec = self.spec(url=initial)
                with patch.dict(os.environ, {"HF_TOKEN": "test-hf-token", "CIVITAI_API_TOKEN": "test-civitai-token"}), patch.object(download.aiohttp, "ClientSession", return_value=session), patch.object(download.aiohttp, "TCPConnector"):
                    await download.download_file(spec, {})
                self.assertEqual(["Authorization" in call.kwargs["headers"] for call in session.get.call_args_list], expected)
                Path(spec["target_path"]).unlink()


class Api(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.download_hits = 0
        self.submissions = []
        self.files_at_submission = []
        file_app = web.Application()
        file_app.router.add_get("/{mode}", self.serve_file)
        self.file_server = TestServer(file_app)
        await self.file_server.start_server()
        self.resolver = patch.object(download, "PublicResolver", LoopbackTestResolver)
        self.resolver.start()
        fake_nodes = types.ModuleType("nodes")
        fake_nodes.NODE_CLASS_MAPPINGS = {"Output": type("Output", (), {"OUTPUT_NODE": True})}
        fake_server = types.ModuleType("server")
        app = web.Application()
        fake_server.PromptServer = types.SimpleNamespace(instance=types.SimpleNamespace(routes=web.RouteTableDef(), app=app))
        with patch.dict(sys.modules, {"nodes": fake_nodes, "server": fake_server}):
            self.api = importlib.import_module("gw_test_package.api")
        self.api.nodes = fake_nodes
        self.api.PromptServer = fake_server.PromptServer
        self.api.manager = download.DownloadManager()
        self.api.register_routes()
        self.folders = patch.object(folder_paths, "folder_names_and_paths", {"loras": ([self.temp.name], {".safetensors"}), "diffusion_models": ([self.temp.name], {".safetensors"})})
        self.folders.start()
        app.router.add_routes(fake_server.PromptServer.instance.routes)
        app.router.add_post("/prompt", self.submit_prompt)
        app.router.add_post("/api/prompt", self.submit_prompt)
        self.client = TestClient(TestServer(app))
        await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close()
        self.resolver.stop()
        await self.file_server.close()
        self.folders.stop()
        self.temp.cleanup()

    async def serve_file(self, request):
        self.download_hits += 1
        if request.match_info["mode"] == "html":
            return web.Response(text="<html>login</html>", content_type="text/html")
        return web.Response(body=b"model-data", content_type="application/octet-stream")

    async def submit_prompt(self, request):
        self.submissions.append(await request.json())
        self.files_at_submission.append({path.relative_to(self.temp.name).as_posix() for path in Path(self.temp.name).rglob("*.safetensors")})
        return web.json_response({"prompt_id": "test-prompt", "number": 0, "node_errors": {}})

    def prompt_request(self):
        model = {
            "category": "diffusion_models", "relative_path": "nested/gw-api.safetensors", "source": "scan",
            "url": str(self.file_server.make_url("/file").with_host("models.test")),
            "size_bytes": 10, "sha256": hashlib.sha256(b"model-data").hexdigest(),
        }
        return {
            "prompt": {
                "1": {"class_type": "UNETLoader", "inputs": {"unet_name": os.path.join("nested", "gw-api.safetensors")}},
                "2": {"class_type": "Output", "inputs": {"model": ["1", 0], "seed": 123}},
            },
            "client_id": "software-client", "number": 3,
            "model_manifest": {"version": 1, "models": [model]},
        }

    async def test_prompt_downloads_before_original_handler_and_rechecks_each_run(self):
        data = self.prompt_request()
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual((await response.json())["prompt_id"], "test-prompt")
        self.assertIn("nested/gw-api.safetensors", self.files_at_submission[0])
        self.assertEqual(self.submissions[0], data)
        self.assertEqual(self.download_hits, 1)
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.download_hits, 1)
        Path(self.temp.name, "nested/gw-api.safetensors").unlink()
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.download_hits, 2)
        self.assertEqual(len(self.submissions), 3)

    async def test_prompt_reads_workflow_manifest_from_subgraph(self):
        data = self.prompt_request()
        saved = data.pop("model_manifest")
        data["extra_data"] = {"extra_pnginfo": {"workflow": {
            "nodes": [{"id": 8, "type": "subgraph-id"}],
            "definitions": {"subgraphs": [{"nodes": [{"type": "GW/ModelManifest", "properties": {"gw_model_manifest": saved}}]}]},
        }}}
        response = await self.client.post("/api/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertIn("nested/gw-api.safetensors", self.files_at_submission[0])
        self.assertEqual(self.submissions[0], data)

    async def test_prompt_failure_does_not_call_original_handler(self):
        data = self.prompt_request()
        data["model_manifest"]["models"][0]["url"] = str(self.file_server.make_url("/html").with_host("models.test"))
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 502)
        result = await response.json()
        self.assertEqual(result["error"]["type"], "gw_model_preparation_failed")
        self.assertIn("gw-api.safetensors", result["error"]["details"])
        self.assertEqual(self.submissions, [])
        self.assertFalse(Path(self.temp.name, "nested/gw-api.safetensors").exists())

    async def test_prompt_explicit_manual_files_do_not_need_loader_references(self):
        data = self.prompt_request()
        data["model_manifest"]["models"][0].pop("source")
        data["model_manifest"]["models"][0]["required"] = True
        data["prompt"] = {"2": {"class_type": "Output", "inputs": {"seed": 123}}}
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertIn("nested/gw-api.safetensors", self.files_at_submission[0])
        self.assertEqual(self.download_hits, 1)

    async def test_prompt_candidates_follow_current_loader_selection(self):
        data = self.prompt_request()
        first = data["model_manifest"]["models"][0]
        first["unused"] = True
        second = {**first, "relative_path": "model-fp8.safetensors", "source": "manual", "unused": False}
        data["model_manifest"]["models"].extend([second, {**first, "relative_path": "unused-without-url.safetensors", "url": ""}])
        data["prompt"]["1"]["inputs"]["unet_name"] = second["relative_path"]
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.files_at_submission[0], {second["relative_path"]})
        self.assertEqual(self.download_hits, 1)
        data["prompt"]["1"]["inputs"]["unet_name"] = os.path.join("nested", "gw-api.safetensors")
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertIn(first["relative_path"], self.files_at_submission[1])
        self.assertEqual(self.download_hits, 2)

    async def test_prompt_connected_selection_node_carries_its_own_catalog(self):
        data = self.prompt_request()
        catalog = data.pop("model_manifest")
        chosen = catalog["models"][0]
        catalog["models"].append({**chosen, "relative_path": "unused-bf16.safetensors", "url": ""})
        data["prompt"]["9"] = {"class_type": "GW/ModelManifest", "inputs": {
            "selected_model": "diffusion_models/" + chosen["relative_path"],
            "manifest": json.dumps(catalog),
        }}
        data["prompt"]["1"]["inputs"]["unet_name"] = ["9", 0]
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.files_at_submission[0], {chosen["relative_path"]})
        self.assertEqual(self.submissions[0], data)
        self.assertEqual(self.download_hits, 1)
        node = model_node.ModelManifest()
        self.assertEqual(node.select_model(**data["prompt"]["9"]["inputs"]), (os.path.join("nested", "gw-api.safetensors"),))

    async def test_unconnected_catalog_prepares_final_software_choices_before_enqueue(self):
        data = self.prompt_request()
        catalog = data.pop("model_manifest")
        original = catalog["models"][0]
        unet = {**original, "relative_path": "software-fp8.safetensors", "source": "manual"}
        clip = {**original, "category": "text_encoders", "relative_path": "text-bf16.safetensors", "source": "manual"}
        catalog["models"].extend([unet, clip, {**clip, "relative_path": "unselected-text-fp8.safetensors", "url": ""}])
        folder_paths.folder_names_and_paths["text_encoders"] = ([self.temp.name], {".safetensors"})
        data["prompt"]["1"]["inputs"]["unet_name"] = unet["relative_path"]
        data["prompt"]["3"] = {"class_type": "CLIPLoader", "inputs": {"clip_name": clip["relative_path"], "type": "stable_diffusion"}}
        data["prompt"]["2"]["inputs"]["clip"] = ["3", 0]
        data["prompt"]["9"] = {"class_type": "GW/ModelManifest", "inputs": {
            "selected_model": "diffusion_models/" + original["relative_path"], "manifest": json.dumps(catalog),
        }}
        data["extra_data"] = {"extra_pnginfo": {"workflow": {"nodes": [
            {"id": 1, "type": "UNETLoader", "widgets_values": [original["relative_path"]]},
            {"id": 9, "type": "GW/ModelManifest", "properties": {"gw_model_manifest": catalog}},
        ]}}}
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.files_at_submission[0], {unet["relative_path"], clip["relative_path"]})
        self.assertEqual(self.submissions[0], data)
        self.assertEqual(self.download_hits, 2)
        Path(self.temp.name, unet["relative_path"]).unlink()
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.download_hits, 3)
        self.assertEqual(self.submissions[1], data)

    async def test_prompt_unconnected_catalog_and_unselected_manual_rows_do_not_download(self):
        data = self.prompt_request()
        catalog = data.pop("model_manifest")
        catalog["models"][0]["source"] = "manual"
        data["prompt"] = {
            "2": {"class_type": "Output", "inputs": {"seed": 123}},
            "9": {"class_type": "GW/ModelManifest", "inputs": {"selected_model": "", "manifest": json.dumps(catalog)}},
        }
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.download_hits, 0)
        self.assertEqual(self.files_at_submission[0], set())

    async def test_prompt_disabled_node_catalog_passes_through(self):
        data = self.prompt_request()
        catalog = data.pop("model_manifest")
        catalog["enabled"] = False
        data["prompt"]["9"] = {"class_type": "GW/ModelManifest", "inputs": {"selected_model": "", "manifest": json.dumps(catalog)}}
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.download_hits, 0)

    async def test_prompt_missing_url_and_bad_version_fail_before_download(self):
        data = self.prompt_request()
        data["model_manifest"]["models"][0]["url"] = ""
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 400)
        self.assertIn("缺少下载地址", (await response.json())["error"]["details"])
        data["model_manifest"]["version"] = 2
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 400)
        self.assertEqual(self.download_hits, 0)
        self.assertEqual(self.submissions, [])

    async def test_prompt_only_prepares_current_execution_branch(self):
        data = self.prompt_request()
        data["prompt"].update({
            "3": {"class_type": "UNETLoader", "inputs": {"unet_name": "unused.safetensors"}},
            "4": {"class_type": "Output", "inputs": {"model": ["3", 0]}},
        })
        data["model_manifest"]["models"].append({"category": "diffusion_models", "relative_path": "unused.safetensors", "source": "scan", "url": ""})
        data["partial_execution_targets"] = ["2"]
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.download_hits, 1)
        self.assertFalse(Path(self.temp.name, "unused.safetensors").exists())

    async def test_prompt_preserves_requests_without_or_with_disabled_manifest(self):
        data = self.prompt_request()
        saved = data.pop("model_manifest")
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200)
        data["extra_data"] = {"extra_pnginfo": {"workflow": {"nodes": [{"type": "GW/ModelManifest", "properties": {"gw_manifest_enabled": False, "gw_model_manifest": saved}}]}}}
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200)
        data["extra_data"] = {}
        saved["models"][0]["enabled"] = False
        data["model_manifest"] = saved
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200)
        self.assertEqual(self.download_hits, 0)
        self.assertEqual(len(self.submissions), 3)

    async def test_prompt_reachability_and_partial_execution(self):
        prompt = {
            "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "used.safetensors"}},
            "2": {"class_type": "UNETLoader", "inputs": {"unet_name": "unused.safetensors"}},
            "3": {"class_type": "Output", "inputs": {"model": ["1", 0]}},
        }
        response = await self.client.post("/editing_gw/models/scan", json={"prompt": prompt})
        data = await response.json()
        self.assertEqual([item["relative_path"] for item in data["models"]], ["used.safetensors"])
        response = await self.client.post("/editing_gw/models/scan", json={"prompt": prompt, "targets": ["2"]})
        self.assertEqual((await response.json())["models"][0]["relative_path"], "unused.safetensors")

    async def test_origin_and_download_boundaries(self):
        response = await self.client.post("/editing_gw/downloads", json={"models": []}, headers={"Origin": "https://evil.example"})
        self.assertEqual(response.status, 403)
        response = await self.client.post("/editing_gw/downloads", json={"models": [{"category": "loras", "relative_path": "test.safetensors", "url": "http://127.0.0.1/file"}]})
        self.assertEqual(response.status, 400)
        self.assertEqual(self.api.manager.jobs, {})

    async def test_prompt_rejects_cross_origin_before_any_download(self):
        for path in ("/prompt", "/api/prompt"):
            for headers in ({"Origin": "https://evil.example"}, {"Sec-Fetch-Site": "cross-site"}):
                with self.subTest(path=path, headers=headers):
                    response = await self.client.post(path, json=self.prompt_request(), headers=headers)
                    self.assertEqual(response.status, 403, await response.text())
        self.assertEqual(self.download_hits, 0)
        self.assertEqual(self.submissions, [])
        self.assertEqual(self.api.manager.jobs, {})

    async def test_prompt_accepts_same_origin(self):
        response = await self.client.post("/prompt", json=self.prompt_request(), headers={"Origin": str(self.client.make_url("/").origin())})
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.download_hits, 1)

    async def test_import_route_registers_candidates_without_starting_downloads(self):
        result = {"models": [{"category": "diffusion_models", "relative_path": "a.safetensors", "required": False}], "warnings": []}
        reader = AsyncMock(return_value=result)
        with patch.object(self.api, "import_models", reader):
            response = await self.client.post("/editing_gw/models/import", json={"url": "https://modelscope.cn/models/A/B", "category": "loras"})
            self.assertEqual(response.status, 200)
            self.assertEqual((await response.json())["models"], result["models"])
            reader.assert_awaited_once_with("https://modelscope.cn/models/A/B", "loras")
            response = await self.client.post("/editing_gw/models/import", json={"url": "https://modelscope.cn/models/A/B"}, headers={"Origin": "https://evil.example"})
            self.assertEqual(response.status, 403)
            self.assertEqual(reader.await_count, 1)
        with patch.object(self.api, "import_models", AsyncMock(side_effect=asyncio.TimeoutError)):
            response = await self.client.post("/editing_gw/models/import", json={"url": "https://modelscope.cn/models/A/B"})
            self.assertEqual(response.status, 502)
            self.assertIn("检查网络", (await response.json())["error"])
        self.assertEqual(self.api.manager.jobs, {})
        self.assertEqual(self.download_hits, 0)

    async def test_imported_candidates_download_only_the_selected_file(self):
        data = self.prompt_request()
        chosen = data["model_manifest"]["models"][0]
        chosen.update(source="modelscope", required=False)
        data["model_manifest"]["models"].append({**chosen, "relative_path": "unselected-bf16.safetensors"})
        response = await self.client.post("/prompt", json=data)
        self.assertEqual(response.status, 200, await response.text())
        self.assertEqual(self.download_hits, 1)
        self.assertEqual(self.files_at_submission[0], {chosen["relative_path"]})

    async def test_existing_only_plan_and_malformed_list(self):
        Path(self.temp.name, "test.safetensors").write_bytes(b"local-file")
        response = await self.client.post("/editing_gw/models/check", json={"models": [{"category": "loras", "relative_path": "test.safetensors"}]})
        self.assertEqual((await response.json())["models"][0]["status"], "exists")
        response = await self.client.post("/editing_gw/models/check", json={"models": [None]})
        self.assertEqual(response.status, 400)


if __name__ == "__main__":
    unittest.main()
