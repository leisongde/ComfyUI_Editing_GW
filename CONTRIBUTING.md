# 开发与验证

插件运行于 ComfyUI 内，不是可单独启动的服务。修改节点后重启 ComfyUI，修改前端资源后刷新页面。

## 环境

- Python 3.11+；Node.js 22 用于前端单元测试。
- 一份较新 ComfyUI 源码，提供真实的 `folder_paths` 路径与缓存接口。
- 测试环境安装 `requirements-dev.txt`。不需要下载模型或安装 PyTorch 来运行本仓库的单元测试。

建议使用独立虚拟环境，避免改动现有 ComfyUI 的依赖。以下命令均在插件根目录执行。

Windows PowerShell：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
$env:COMFYUI_PATH = 'C:\path\to\ComfyUI'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHONUTF8 = '1'
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
node --experimental-vm-modules tests/test_frontend.mjs
```

Linux / macOS：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
export COMFYUI_PATH=/path/to/ComfyUI
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tests -v
node --experimental-vm-modules tests/test_frontend.mjs
```

`COMFYUI_PATH` 指向包含 `folder_paths.py` 的目录。未设置时，测试按 `ComfyUI/custom_nodes/本插件` 的安装位置查找 ComfyUI，不搜索个人磁盘目录。

## 验证范围

后端测试使用真实 ComfyUI 路径工具，覆盖路径穿越、符号链接、模型选择、临时文件安装、取消、哈希校验、私网地址拦截、跨站请求与凭据转发边界。HTTP 传输测试通过测试专用解析器访问本地服务器；生产解析器不允许私网下载。API 测试模拟 ComfyUI 节点注册和最终入队处理，不执行模型推理。

前端测试模拟 ComfyUI 的 app、api 和浏览器存储，覆盖清单合并、导出恢复和提交时模型选择。它不能替代真实页面和 GPU 工作流验证。

`tests/browser_*.js` 是接收 Playwright `page` 对象的异步回调，需要已启动、已安装本插件的独立测试 ComfyUI，以及可注入回调的浏览器测试工具；不能直接用 `node` 运行。脚本会清空或替换当前画布，应使用专门的测试页面。截图、日志和测试用户数据放到 `output/`，不要提交。

CI 对公开上游 ComfyUI 的最新默认分支进行测试；其路径接口改变时可能需要同步适配。发布说明应记录实际验证过的 ComfyUI 和前端版本，而不是仅凭 CI 声明全面兼容。

## 提交前

运行以上测试，说明修改对应的问题及验证范围。Bug 报告请附操作系统、Python / ComfyUI / 前端版本、复现步骤和已脱敏的最小工作流。不要提交环境变量值、私人下载链接、模型文件、浏览器日志或个人目录截图。提交到本项目的贡献应采用与项目一致的 MIT 许可证，并确保你有权提交这些内容。
