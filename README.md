# ComfyUI Editing GW · 模型依赖管理

在工作流中放置一个 **GW 模型依赖** 节点，登记模型及候选版本的下载地址，运行前只补齐实际选中的文件。**默认无需连线**，以 UNET、CLIP、VAE 等加载器的最终输入为准。

[GitHub 仓库](https://github.com/leisongde/ComfyUI_Editing_GW) · [v0.1.0 发布页](https://github.com/leisongde/ComfyUI_Editing_GW/releases/tag/v0.1.0) · [MIT 许可证](LICENSE)

## 安装与环境

1. [下载 v0.1.0 ZIP](https://github.com/leisongde/ComfyUI_Editing_GW/archive/refs/tags/v0.1.0.zip) 并解压，将文件夹命名为 `ComfyUI_Editing_GW`，放入 `ComfyUI/custom_nodes/`。`__init__.py` 应直接位于该文件夹内，避免多嵌套一层目录。
2. 重启 ComfyUI，刷新浏览器，在 **GW** 分类搜索 **GW 模型依赖**（节点类型为 `GW/ModelManifest`）。
3. 更新时用新版替换插件文件并重启；卸载时移除插件文件夹。已经下载的模型文件会保留。

也可以在 ComfyUI 根目录通过 Git 安装：

```sh
git clone https://github.com/leisongde/ComfyUI_Editing_GW.git custom_nodes/ComfyUI_Editing_GW
```

使用 Python 3.11 或更新版本，运行环境由 ComfyUI 提供，包括 `aiohttp` 和 `yarl`，正常安装无需额外安装 Python 包。插件依赖较新 ComfyUI 的 `folder_paths.map_legacy`、`is_within_directory` 和目录缓存接口，以及前端 `app.rootGraph`、`graphToPrompt`、`api.queuePrompt` 等接口；旧版缺少这些接口时请先更新 ComfyUI。尚未建立完整的 ComfyUI 版本兼容矩阵。

## 使用

作者制作工作流：

1. 添加节点，点击“扫描工作流”。添加节点时也会自动扫描一次。
2. 打开“编辑清单 / 下载缺失”，为模型填写 HTTP(S) 文件直链。
3. 点击“添加模型”，登记 bf16、fp8 等候选版本，选择保存类别并填写相对子路径及下载地址。默认下载条件为“选中时”。
4. 点击“检查本地”检查状态，正常保存工作流。

接收者运行工作流：

1. 安装此插件以及工作流使用的其他自定义节点。
2. 打开工作流，**本机运行前自动补齐缺失模型** 默认开启；如果之前手动关闭过，在清单面板重新开启即可。
3. 正常点击 ComfyUI 的“运行”。插件先下载缺失文件，检查完成后继续提交同一次任务。

也可以直接点击“补齐当前选择”。打开、扫描、保存工作流不会触发模型下载；文件已存在时不会请求下载源。每次运行重新检查，因此以后删掉模型也能再次补齐。

## 从魔搭目录批量登记

在清单面板展开“从魔搭链接批量登记”，粘贴仓库首页或目录链接，点击“批量登记”。例如：

`https://modelscope.cn/models/Comfy-Org/MiniMax-H3/tree/master/diffusion_models`

插件读取该目录及子目录中的模型文件，自动填写文件名、下载直链、大小和 SHA256，并按仓库目录识别 `diffusion_models`、`text_encoders`、`loras`、`vae` 等本机保存类别。README、配置等非模型文件不会批量登记。无法识别类别的目录可在导入前选择默认类别，也可导入后逐项确认。

重复导入按类别和相对子路径去重；同类别中唯一的同名模型也会匹配已有条目，保留原有子目录、地址、引用及启用状态。只补充空缺信息；大小或哈希冲突会提示核对。导入项默认“选中时”下载，登记时不会下载模型。单个添加、扫描工作流和原有下载行为保持不变。

## 不连线使用（软件 API 推荐）

GW 节点留在画布上，不需要接到加载器，也不需要让加载器反向连接它。你们的软件继续给 `UNETLoader.unet_name`、`CLIPLoader.clip_name` 等字段填入用户选择的模型名。

提交任务后的顺序固定为：接收 `/prompt` → 读取加载器本次最终模型名 → 从清单匹配地址 → 下载缺失文件 → ComfyUI 原有校验、排队和执行。GW 节点在计算图中的位置和是否连线都不决定这个顺序；后端在入队前完成检查，不需要把它设成第一个执行的计算节点。

例如清单登记了主模型 bf16、fp8 和文本编码器 bf16、fp8；软件提交主模型 fp8＋文本编码器 bf16，插件只补齐这两个版本。工作流保存时的旧选择和未连接的 GW 选型值均不会覆盖本次加载器输入。

## 可选连线选型

例如登记 `diffusion_models/model-bf16.safetensors` 和 `diffusion_models/model-fp8.safetensors`，分别填写下载地址：

1. 将 `UNETLoader` 的 `unet_name` 转为输入（右键加载器，转换控件为输入）。
2. 把 GW 节点的“模型名称”输出连接到这个输入。
3. 连线后会显示 GW 节点的“选择模型”下拉框。选择 fp8，运行时只下载 fp8；以后改选 bf16，缺失时才下载 bf16。

选择框包含已登记但尚未下载的模型，不依赖本机已安装文件列表。Checkpoint、CLIP、VAE、LoRA 等模型下拉输入也可以这样连接。每个 GW 节点输出一个模型名称；主模型、文本编码器等需要独立选择时，可分别放置 GW 节点，再连接到对应加载器，实现不同组合。

扫描条目和手动条目默认都只在当前执行分支选中时补齐。暂时没被引用的扫描条目会保留为候选，以后重新选中仍能匹配下载地址。只有与加载器无直接引用关系、但每次都需要的额外文件，才将其下载条件改成“始终需要”。该条件会随工作流保存。

## 软件调用 ComfyUI 后端

直接调用 `/prompt` 或 `/api/prompt` 时，插件在后端自动补齐，无需打开 ComfyUI 网页或设置浏览器开关。新版 GW 节点会把完整候选清单放进 API 工作流，因此可以直接提交 API 导出的 `prompt`：

```python
import json
import requests

with open("workflow_api.json", encoding="utf-8") as source:
    prompt = json.load(source)

# GW 节点保持不连线，软件照常修改加载器的模型名。
# 节点 ID 与文件名以你们的工作流为准。
prompt["1"]["inputs"]["unet_name"] = "model-fp8.safetensors"
response = requests.post(
    "http://127.0.0.1:8188/prompt",
    json={"prompt": prompt},
    timeout=(15, None),
)
response.raise_for_status()
```

保留 API 工作流中的 `GW/ModelManifest` 节点及其 `inputs.manifest` JSON 字符串即可，不需要填写它的 `selected_model`。加载器输入保持模型名字字符串。软件如果过滤未连接节点，需要保留 GW 节点，或按下文单独发送 `model_manifest`。切换版本时不要把未选模型从清单中删除。

如果主动使用可选连线选型，加载器输入才是 `[GW节点ID, 0]`，此时修改 GW 节点的 `selected_model`（格式为“类别/相对子路径”）。软件直接填写加载器模型名的接入方式应保持不连线。

也支持把普通工作流放进标准的 `extra_data.extra_pnginfo.workflow` 字段，适用于已有的工作流接入方式：

```python
import json
import requests

with open("workflow_api.json", encoding="utf-8") as source:
    prompt = json.load(source)
with open("workflow.json", encoding="utf-8") as source:
    workflow = json.load(source)

response = requests.post(
    "http://127.0.0.1:8188/prompt",
    json={
        "prompt": prompt,
        "extra_data": {"extra_pnginfo": {"workflow": workflow}},
    },
    timeout=(15, None),
)
response.raise_for_status()
result = response.json()
```

如果软件自行构造 API 工作流、没有保留 GW 节点，也可以在 `/prompt` 请求体增加 `model_manifest` 字段。新增部分例如：

```json
{
  "model_manifest": {
    "version": 1,
    "models": [
      {
        "category": "diffusion_models",
        "relative_path": "example.safetensors",
        "url": "https://huggingface.co/OWNER/REPO/resolve/REVISION/example.safetensors"
      }
    ]
  }
}
```

可以直接使用节点的 `properties.gw_model_manifest` 作为 `model_manifest`。默认只补齐当前执行分支使用的模型，与条目是否手动添加无关；额外必需文件用 `required: true` 声明。`enabled: false` 的条目不参与补齐。`unused` 只表示保存时暂未引用，不会阻止以后重新选中。

后端会等待下载、校验完成，再继续 ComfyUI 原来的校验和排队，成功响应仍为原来的 `prompt_id`、`number`、`node_errors`。失败时返回带有 `gw_model_preparation_failed` 类型的错误，并阻止本次任务入队。每次请求都检查本地文件，已有文件直接跳过。

首次下载可能持续数分钟，软件及反向代理需允许该等待时间。需要自行展示进度或支持取消时，可先调用 `/editing_gw/downloads` 并轮询 `/editing_gw/downloads/{id}`，完成后再提交 `/prompt`。实际 `prompt` 中的模型输入仍遵循 ComfyUI 原有的文件名约定，`/editing_gw/models/check` 的 `loader_value` 可用于获取当前后端的目录分隔格式。

## 文件位置与清单

- 保存的是模型类别与相对子路径，如 `loras`＋`styles/example.safetensors`，接收者按自己的 ComfyUI 目录配置解析位置。
- 检查会搜索该类别的所有模型根目录，包括 `extra_model_paths.yaml` 注册的目录。
- 一个类别有多个根目录时，可以在表格中选择本机下载目录。这个选择及自动下载开关保存在当前浏览器中，不随工作流分享。
- 自动识别的文件路径以原加载器为准；需要改变模型名时，在加载器中修改后重新扫描。手动条目的类别和路径可以直接编辑。
- 重复扫描保留下载地址、哈希、手动条目与停用状态。已失去引用的自动条目标为“候选：当前未引用”。仍被引用的模型删除后会再次扫描出来；不想使用某条候选时取消该条的“启用”。
- 完整清单存于管理节点属性，同时导出原生 `properties.models` 元数据。普通工作流 JSON 和携带工作流元数据的 PNG 均可保存清单。

## 下载与校验

支持 HTTP(S) 文件直链、重定向、下载进度、取消、失败重试、预期字节数和 SHA256。Hugging Face 应使用 `/resolve/版本/文件名` 链接，而不是 `/blob/` 网页地址。

下载使用临时文件，校验成功后才安装；已有文件不自动覆盖。发现已有文件大小或哈希不符时，先移走或删除错误文件，再重新下载。普通检查只检查存在性和可用的大小；填写 SHA256 后，点击“校验已有文件”可做完整校验，大文件需要读取一遍。

需要登录权限的 Hugging Face 或 Civitai 模型，可在启动 ComfyUI 前于本机设置 `HF_TOKEN` 或 `CIVITAI_API_TOKEN` 环境变量。插件从环境变量读取的凭据不会写入工作流；只向对应站点的 HTTPS 标准端口发送，跨主机、跨端口或从 HTTP 跳转到 HTTPS 时不会携带这些凭据。下载目标限定为公开 HTTP(S) 地址及已注册的模型目录。

清单中的下载 URL 会原样保存在工作流 JSON、PNG 元数据和 API 导出中，请勿粘贴带 `token`、`api_key`、签名或其他私人凭据的链接后对外分享。安装和运行来源可信的工作流；模型使用及再分发仍应遵守模型本身的许可证。安全边界及漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 当前覆盖范围

自动识别常见 Checkpoint、UNET、CLIP、多 CLIP、VAE、LoRA、ControlNet、CLIP Vision、Style、GLIGEN、放大模型等加载器，包含部分常用 GGUF 加载器名称。支持主图与子图扫描，运行时以当前执行分支编译后的实际输入为准；普通 Primitive／Reroute 传入的模型名也可以扫描。

第三方加载器优先使用已有模型元数据或本地文件索引匹配；无法确定类别时需要在面板中选择。特殊 TAESD 分体编码器／解码器会提示手动补充到 `vae_approx`。动态脚本选择的文件、多文件模型仓库、网盘登录、断点续传及其他自定义节点安装尚未自动处理。

API 格式导出包含 GW 节点的候选清单和选择结果。没有携带任何清单的 `/prompt` 请求按 ComfyUI 原有流程处理。第三方节点内部在执行时计算的模型名称及任意动态开关分支仍需专项适配；推荐通过 GW 选择框或加载器的明确文件名选择版本。

## 验证

后端测试使用 unittest、`aiohttp` 及真实 ComfyUI 的路径工具，在临时目录和本地 HTTP 测试服务器中完成文件传输，不下载真实模型。若插件位于 `ComfyUI/custom_nodes/`，且使用已安装依赖的 ComfyUI Python，可直接运行：

```powershell
python -m unittest discover -s tests -v
node --experimental-vm-modules tests/test_frontend.mjs
```

独立检出本仓库时，需要设置 `COMFYUI_PATH` 指向 ComfyUI 源码根目录，并安装 `requirements-dev.txt`。详细命令和验证范围见 [CONTRIBUTING.md](CONTRIBUTING.md)。GitHub Actions 配置覆盖 Windows / Linux 与 Python 3.11 / 3.12，需推送到 GitHub 后实际运行确认。

`tests/browser_smoke.js` 验证面板操作、保存恢复、补齐顺序、取消／失败和真实“运行”按钮；`tests/browser_subgraphs.js` 检查子图保存恢复；`tests/browser_selection.js` 检查候选登记、加载器连线、API 导出和 bf16／fp8 切换时只下载所选文件。浏览器测试模拟下载响应与最终提交，未执行大模型推理。

详细设计见 [DESIGN.md](DESIGN.md)。

## 许可证

本项目采用 [MIT License](LICENSE) 开源，允许免费使用、复制、修改、分发及商用，分发时须保留原有版权声明和许可声明。软件按现状提供，不附带担保。此许可证适用于本插件代码，模型及其他第三方内容仍遵循各自的许可证。

版本变更见 [CHANGELOG.md](CHANGELOG.md)。使用问题和功能建议可通过 [GitHub Issues](https://github.com/leisongde/ComfyUI_Editing_GW/issues) 提交。
