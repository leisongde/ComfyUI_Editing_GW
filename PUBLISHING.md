# 发布到 ComfyUI Registry

官方说明：[发布指南](https://docs.comfy.org/registry/publishing) · [元数据规范](https://docs.comfy.org/registry/specifications)。

## 项目身份

- Publisher ID：`leisongde`。
- Registry 节点包 ID：`editing-gw`，与 GitHub 仓库名、画布节点类型 `GW/ModelManifest` 分别用于不同场景。
- 首次 Registry 版本：`0.1.0`。`pyproject.toml` 的版本字段不带 `v`。
- 许可证：MIT。

Publisher ID 和节点包 ID 一经创建不能更改；发布前应确认这些名称。GitHub Release 和 Registry 需要分别发布，已有 GitHub `v0.1.0` 不会自动在 Registry 创建版本。

## 首次发布：使用 GitHub Actions

1. 打开本仓库的 **Settings → Secrets and variables → Actions → New repository secret**。
2. 名称填写 `REGISTRY_ACCESS_TOKEN`，值填写在 Registry 的 `leisongde` 发布者下创建的发布 API 密钥。点击 **Add secret**。这是 Registry 密钥，不是 GitHub Token，也不是模型下载用的令牌。
3. 打开 **Actions → Publish to Comfy Registry → Run workflow**，选择 `main`，再点击 **Run workflow**。
4. 等待该次发布任务完成，在 Registry 的发布者页面确认版本与安全扫描状态。任务日志中的节点页面链接可用于访问发布结果。

发布工作流只允许手动触发，从 `main` 打包。它不会执行本项目测试，也不会在每次提交时自动发布。`.comfyignore` 会将测试、内部设计文档和开发文件排除在 Registry 安装包外，运行代码、`web/`、README 和 LICENSE 会保留。

不要把 API 密钥填进 `pyproject.toml`、工作流 YAML、README、聊天或 Git 提交中。如果密钥失效，在 Registry 生成新密钥后替换同名 GitHub Secret 即可。

## 后续版本

1. 修改代码与更新记录。
2. 将 `pyproject.toml` 的 `version` 改成新的语义化版本，例如 `0.1.1`，提交并推送到 GitHub。
3. 手动运行同一个发布工作流。

Registry 已发布的版本内容不可覆盖。只有发布任务失败、且 Registry 中没有创建该版本时，才使用原版本重试；若版本已经存在，应先确认已有发布结果，再决定是否增加版本号。

## 可选：本地发布

本机安装 [comfy-cli](https://docs.comfy.org/comfy-cli/getting-started) 后，在本仓库根目录运行：

```powershell
comfy node publish
```

按提示输入 Registry 密钥。运行前确保发布文件已经提交，因为 CLI 默认打包 Git 跟踪的文件。GitHub Actions 和本地发布二选一即可，同一版本不要重复发布。
