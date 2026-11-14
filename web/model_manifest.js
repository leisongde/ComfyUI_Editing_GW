import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const TYPE = "GW/ModelManifest";
const AUTO_KEY = "ComfyUI.EditingGW.AutoDownload";
const ROOTS_KEY = "ComfyUI.EditingGW.ModelRoots";
const MODEL_FILE = /\.(safetensors|sft|ckpt|pt2?|pth|bin|pkl|gguf|onnx|tflite|model|json|txt|vocab|ya?ml)$/i;
const STATUS = { exists: "已存在", missing: "缺失", no_url: "缺少地址", invalid: "文件大小不符", queued: "等待下载", downloading: "下载中", complete: "已完成", cancelled: "已取消", failed: "失败" };
let loaderRules = {};
let modelCategories = [];
let modelFolders = {};
let vaeApproxModels = [];
let separator = "/";
const loadedModelValues = new WeakMap();

function rootIndices() {
    try { return JSON.parse(localStorage.getItem(ROOTS_KEY) ?? "{}"); }
    catch { return {}; }
}

function pathOf(value) {
    return String(value ?? "").replaceAll("\\", "/");
}

function keyOf(row) {
    return `${row.category}/${pathOf(row.relative_path)}`;
}

function liveNodes(graph = app.rootGraph ?? app.graph, prefix = "", result = []) {
    for (const node of graph?._nodes ?? []) {
        const id = prefix + node.id;
        result.push({ node, id });
        if (node.subgraph) liveNodes(node.subgraph, id + ":", result);
    }
    return result;
}

function serializedNodes(graph, result = []) {
    result.push(...(graph?.nodes ?? []));
    for (const subgraph of graph?.definitions?.subgraphs ?? []) serializedNodes(subgraph, result);
    return result;
}

function manifest(node) {
    const value = node.properties?.gw_model_manifest;
    if (value && value.version !== 1) throw new Error(`不支持的 GW 模型清单版本：${value.version}`);
    if (value && !Array.isArray(value.models)) throw new Error("GW 模型清单的 models 必须是数组");
    return value ?? { version: 1, models: [] };
}

function primitiveValue(node, input, seen = new Set()) {
    if (input.link == null || seen.has(input.link)) return;
    seen.add(input.link);
    const link = node.graph.links.get(input.link);
    const source = link && node.graph.getNodeById(link.origin_id);
    if (source?.type === "PrimitiveNode") return source.widgets?.[0]?.value;
    if (source?.type === TYPE) {
        const selection = source.widgets?.find(widget => widget.name === "selected_model")?.value;
        return manifest(source).models.find(row => keyOf(row) === selection)?.relative_path;
    }
    if (source?.type === "Reroute" && source.inputs?.[0]) return primitiveValue(source, source.inputs[0], seen);
}

function scanPayload(graph) {
    return liveNodes(graph).map(({ node, id }) => ({
        node_id: id,
        node_type: node.type,
        inputs: Object.fromEntries([
            ...(node.widgets ?? []).filter(w => typeof w.value === "string").map(w => [w.name, w.value]),
            ...(node.inputs ?? []).map(input => [input.name, primitiveValue(node, input)]).filter(([, value]) => typeof value === "string"),
        ]),
        models: node.properties?.models ?? [],
    }));
}

function localScan(graph, existing) {
    const rows = new Map();
    for (const node of scanPayload(graph)) {
        if (node.node_type === TYPE) {
            const saved = JSON.parse(node.inputs.manifest ?? '{"models":[]}');
            const selected = saved.models.find(row => keyOf(row) === node.inputs.selected_model);
            if (selected && saved.enabled !== false) rows.set(keyOf(selected), { ...selected, source: "scan", references: [{ node_id: node.node_id, input_name: "selected_model" }] });
            continue;
        }
        for (const [name, value] of Object.entries(node.inputs)) {
            if (!MODEL_FILE.test(value)) continue;
            const path = pathOf(value);
            const previous = existing.filter(row => row.relative_path === path && row.references?.some(ref => ref.node_id === node.node_id && ref.input_name === name));
            let category = loaderRules[node.node_type]?.[name] ?? (previous.length === 1 ? previous[0].category : undefined);
            if (node.node_type === "VAELoader" && name === "vae_name" && vaeApproxModels.includes(path.split("/").at(-1).replace(/\.[^.]+$/, ""))) category = "vae_approx";
            if (category === undefined) continue;
            const row = { category, relative_path: path, url: "", enabled: true, source: "scan", references: [] };
            const key = keyOf(row);
            if (!rows.has(key)) rows.set(key, row);
            rows.get(key).references.push({ node_id: node.node_id, input_name: name });
        }
    }
    const byId = new Map(liveNodes(graph).map(item => [item.id, item.node]));
    for (const row of existing.filter(item => item.source === "scan")) {
        const unresolved = (row.references ?? []).filter(ref => {
            const node = byId.get(ref.node_id);
            const input = node?.inputs?.find(input => input.name === ref.input_name);
            return input?.link != null && primitiveValue(node, input) === undefined;
        });
        if (unresolved.length && !rows.has(keyOf(row))) rows.set(keyOf(row), { ...row, references: unresolved });
    }
    return [...rows.values()];
}

function mergeScan(existing, scanned) {
    const merged = existing.map(row => {
        row.references = row.source === "scan" ? [] : row.references ?? [];
        row.unused = row.source === "scan";
        return row;
    });
    for (const row of scanned) {
        let previous = merged.find(item => keyOf(item) === keyOf(row));
        if (!previous && !row.category) {
            const candidates = merged.filter(item => item.relative_path === row.relative_path);
            if (candidates.length === 1) previous = candidates[0];
        }
        if (previous) {
            previous.references.push(...row.references.filter(ref => !previous.references.some(old => old.node_id === ref.node_id && old.input_name === ref.input_name)));
            previous.unused = false;
            if (!previous.url && row.url) previous.url = row.url;
            if (!previous.sha256 && row.sha256) previous.sha256 = row.sha256;
        } else {
            merged.push({ ...row, unused: false });
        }
    }
    return merged;
}

function projectModels(node) {
    node.properties.models = manifest(node).models.filter(row => row.enabled !== false && row.category && row.url).map(row => ({
        name: row.relative_path,
        directory: row.category,
        url: row.url,
        ...(row.sha256 ? { hash: row.sha256, hash_type: "sha256" } : {}),
    }));
}

function mergeImported(existing, imported) {
    const models = existing.map(row => ({ ...row }));
    const nameKey = row => `${row.category}/${pathOf(row.relative_path).split("/").at(-1)}`;
    const nameCounts = new Map();
    for (const row of imported) nameCounts.set(nameKey(row), (nameCounts.get(nameKey(row)) ?? 0) + 1);
    let added = 0, filled = 0, conflicts = 0;
    for (const row of imported) {
        let previous = models.find(item => keyOf(item) === keyOf(row));
        if (!previous && nameCounts.get(nameKey(row)) === 1) {
            const matches = models.filter(item => nameKey(item) === nameKey(row));
            if (matches.length === 1) previous = matches[0];
        }
        if (!previous) {
            models.push(row);
            added++;
            continue;
        }
        if (["sha256", "size_bytes"].some(field => previous[field] && row[field] && previous[field] !== row[field])) {
            conflicts++;
            continue;
        }
        // Keep each URL paired with its original verification data.
        if (previous.url && previous.url !== row.url) continue;
        let changed = false;
        for (const field of ["url", "sha256", "size_bytes"]) {
            if (!previous[field] && row[field]) { previous[field] = row[field]; changed = true; }
        }
        if (changed) filled++;
    }
    if (models.length > 5000) throw new Error("合并后超过 5000 个模型，请缩小导入目录或删除不需要的条目。");
    return { models, added, filled, duplicates: imported.length - added, conflicts };
}

function updateNode(node, models) {
    node.properties.gw_model_manifest = { version: 1, models };
    projectModels(node);
    const active = models.filter(row => row.enabled !== false);
    const selection = node.widgets.find(widget => widget.name === "selected_model");
    const connected = !!node.outputs[0]?.links?.length;
    selection.hidden = !connected;
    selection.options.hidden = !connected;
    selection.options.values = ["", ...new Set(active.filter(row => row.category && row.relative_path).map(keyOf))];
    node.widgets.find(widget => widget.name === "manifest").value = JSON.stringify({ ...manifest(node), enabled: node.properties.gw_manifest_enabled !== false });
    node.summary.name = `${connected ? "" : "无需连线 · "}候选 ${active.length} 项 · 未填地址 ${active.filter(row => !row.url).length} 项`;
    node.setDirtyCanvas(true, true);
}

async function request(path, data) {
    if (data && (path === "/models/check" || path === "/downloads")) data = { ...data, root_indices: rootIndices() };
    const response = await api.fetchApi(`/editing_gw${path}`, data === undefined ? {} : {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? `请求失败：HTTP ${response.status}`);
    if (result.categories) modelCategories = result.categories;
    if (result.folders) modelFolders = result.folders;
    if (result.vae_approx_models) vaeApproxModels = result.vae_approx_models;
    if (result.loaders) loaderRules = result.loaders;
    if (result.separator) separator = result.separator;
    return result;
}

async function scanNode(node) {
    const graph = app.rootGraph ?? app.graph;
    const compiled = await app.graphToPrompt(graph);
    const nodes = scanPayload(graph);
    for (const [id, item] of Object.entries(compiled.output)) {
        const existing = nodes.find(node => node.node_id === id);
        if (existing) Object.assign(existing.inputs, Object.fromEntries(Object.entries(item.inputs).filter(([, value]) => typeof value === "string")));
        else nodes.push({ node_id: id, node_type: item.class_type, inputs: item.inputs });
    }
    const result = await request("/models/scan", { nodes, metadata: compiled.workflow.models ?? [] });
    if (!node.graph) return result;
    updateNode(node, mergeScan(manifest(node).models, result.models));
    node.graph.change();
    return result;
}

function element(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
}

function button(text, action) {
    const el = element("button", "", text);
    el.type = "button";
    el.onclick = action;
    return el;
}

function modal(title) {
    const dialog = element("dialog", "gw-model-dialog");
    const header = element("header");
    header.append(element("strong", "", title), button("关闭", () => dialog.close()));
    const content = element("div", "gw-content");
    dialog.append(header, content);
    document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    dialog.showModal();
    return { dialog, content };
}

function notify(error) {
    const { content } = modal("GW 模型依赖");
    content.append(element("pre", "gw-error", error.message ?? String(error)));
}

function formatBytes(value) {
    if (value == null) return "未知大小";
    if (value < 1024) return `${value} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let number = value / 1024;
    let unit = 0;
    while (number >= 1024 && unit < units.length - 1) { number /= 1024; unit++; }
    return `${number.toFixed(1)} ${units[unit]}`;
}

async function downloadMissing(models) {
    const started = await request("/downloads", { models });
    const { dialog, content } = modal("正在补齐模型");
    const status = element("p", "", "等待下载…");
    const list = element("div", "gw-progress-list");
    const cancel = button("取消下载", () => stop());
    content.append(status, list, cancel);
    let finished = false;
    let cancelled = false;
    let failure;
    async function stop() {
        if (finished || cancelled) return;
        cancelled = true;
        cancel.disabled = true;
        try { await request(`/downloads/${started.id}/cancel`, {}); }
        catch (error) { failure = error; }
    }
    dialog.addEventListener("cancel", event => { event.preventDefault(); stop(); });
    dialog.addEventListener("close", () => { stop(); });
    try {
        while (true) {
            const job = await request(`/downloads/${started.id}`);
            list.replaceChildren();
            for (const file of job.files) {
                const item = element("div", "gw-progress-file");
                item.append(element("strong", "", `${file.category}/${file.relative_path}`));
                item.append(element("div", "", `${STATUS[file.status] ?? file.status} · ${formatBytes(file.downloaded)} / ${formatBytes(file.total)}${file.speed ? ` · ${formatBytes(file.speed)}/s` : ""}`));
                if (file.total) {
                    const progress = element("progress");
                    progress.max = file.total;
                    progress.value = file.downloaded;
                    item.append(progress);
                }
                list.append(item);
            }
            status.textContent = cancelled ? "正在取消…" : "模型准备完成后将继续原来的操作。";
            if (["complete", "cancelled", "failed"].includes(job.status)) {
                finished = true;
                const failed = job.files.find(file => file.status === "failed");
                if (job.status !== "complete") throw new Error((failed ? `${failed.relative_path}：` : "") + (job.error ?? "模型下载已取消，本次任务未提交"));
                if (cancelled) throw new Error("模型下载已取消，本次任务未提交");
                dialog.close();
                return;
            }
            if (failure) throw failure;
            await new Promise(resolve => setTimeout(resolve, 700));
        }
    } catch (error) {
        await stop();
        dialog.close();
        throw error;
    }
}

function editNode(node) {
    const { content } = modal("GW 模型依赖清单");
    const toolbar = element("div", "gw-toolbar");
    const message = element("pre", "gw-message", "无需连线：运行前读取 UNET、CLIP、VAE 等加载器的最终模型名，只补齐本次需要的文件。可提前登记 bf16、fp8 候选，额外文件可设为“始终需要”。");
    const table = element("table", "gw-model-table");
    const head = element("tr");
    for (const text of ["启用 / 下载条件", "模型文件 / 校验", "保存类别 / 本机目录", "下载地址", "本地状态", "操作"]) head.append(element("th", "", text));
    const thead = element("thead");
    const tbody = element("tbody");
    thead.append(head);
    table.append(thead, tbody);
    const scroll = element("div", "gw-table-scroll");
    scroll.append(table);
    const statuses = new Map();
    const automatic = element("input");
    automatic.type = "checkbox";
    automatic.checked = localStorage.getItem(AUTO_KEY) !== "false";
    automatic.onchange = () => localStorage.setItem(AUTO_KEY, String(automatic.checked));
    const autoLabel = element("label", "gw-auto");
    autoLabel.append(automatic, document.createTextNode(" 本机运行前自动补齐缺失模型"));

    function changed() {
        updateNode(node, manifest(node).models);
        node.graph?.change();
    }
    async function action(work) {
        message.classList.remove("gw-error");
        try { await work(); }
        catch (error) { message.textContent = error.message; message.classList.add("gw-error"); }
    }
    async function check(verify = false) {
        const models = manifest(node).models.filter(row => row.enabled !== false);
        const result = await request("/models/check", { models, verify_sha256: verify });
        statuses.clear();
        for (const row of result.models) statuses.set(keyOf(row), row);
        message.textContent = `共 ${result.models.length} 项，已存在 ${result.models.filter(row => row.status === "exists").length} 项。`;
        render();
        return result.models;
    }
    function input(value, placeholder, onChange) {
        const field = element("input");
        field.value = value ?? "";
        field.placeholder = placeholder;
        field.onchange = () => { onChange(field.value); changed(); statuses.clear(); };
        return field;
    }
    function render() {
        tbody.replaceChildren();
        for (const row of manifest(node).models) {
            const tr = element("tr", row.unused ? "gw-unused" : "");
            const enabledCell = element("td");
            const enabled = element("input");
            enabled.type = "checkbox";
            enabled.checked = row.enabled !== false;
            enabled.onchange = () => { row.enabled = enabled.checked; changed(); };
            enabledCell.append(enabled);
            const condition = element("select");
            for (const [value, label] of [["selected", "选中时"], ["required", "始终需要"]]) {
                const option = element("option", "", label);
                option.value = value;
                condition.append(option);
            }
            condition.value = row.required ? "required" : "selected";
            condition.onchange = () => { row.required = condition.value === "required"; changed(); };
            enabledCell.append(condition);
            const fileCell = element("td");
            const file = input(row.relative_path, "子目录/模型.safetensors", value => { row.relative_path = pathOf(value.trim()); });
            file.readOnly = row.source === "scan";
            file.title = file.readOnly ? "请在原加载器修改模型，然后重新扫描" : "相对于模型类别根目录的路径";
            const detail = element("details");
            detail.append(element("summary", "", "大小 / SHA256"));
            const size = input(row.size_bytes, "预期字节数（可选）", value => { row.size_bytes = value.trim() ? Number(value) : null; });
            size.inputMode = "numeric";
            detail.append(size, input(row.sha256, "SHA256（可选）", value => { row.sha256 = value.trim(); }));
            fileCell.append(file, element("small", "", row.unused ? "候选：当前未引用" : row.source === "manual" ? "手动登记" : row.source === "modelscope" ? "魔搭导入" : (row.references ?? []).map(ref => `${ref.node_id}.${ref.input_name}`).join("、")), detail);
            const categoryCell = element("td");
            const category = element("select");
            for (const name of ["", ...modelCategories]) {
                const option = element("option", "", name || "请选择类别");
                option.value = name;
                category.append(option);
            }
            category.value = row.category;
            category.disabled = row.source === "scan" && !!row.category;
            category.onchange = () => { row.category = category.value; changed(); statuses.clear(); render(); };
            categoryCell.append(category);
            const roots = modelFolders[row.category] ?? [];
            if (roots.length > 1) {
                const root = element("select", "gw-root");
                roots.forEach((path, index) => {
                    const option = element("option", "", path);
                    option.value = index;
                    root.append(option);
                });
                root.value = rootIndices()[row.category] ?? 0;
                root.title = "本机下载根目录（不随工作流分享）";
                root.onchange = () => {
                    localStorage.setItem(ROOTS_KEY, JSON.stringify({ ...rootIndices(), [row.category]: Number(root.value) }));
                    statuses.clear(); render();
                };
                categoryCell.append(root);
            }
            if (row.category) {
                const path = roots[rootIndices()[row.category] ?? 0];
                const location = element("small", "gw-path", path ? `保存目录：${path}` : "请选择有效的模型目录");
                location.title = path ?? "";
                categoryCell.append(location);
            }
            const urlCell = element("td");
            urlCell.append(input(row.url, "https://… 模型文件直链", value => { row.url = value.trim(); }));
            const stateCell = element("td");
            const state = statuses.get(keyOf(row));
            stateCell.append(element("span", "", !row.category ? "路径待确认" : state ? STATUS[state.status] + (state.hash_verified ? " · SHA256 一致" : "") : "待检查"));
            if (state) stateCell.append(element("small", "gw-path", state.target_path));
            const operations = element("td");
            operations.append(button("删除", () => {
                updateNode(node, manifest(node).models.filter(item => item !== row));
                changed(); render();
            }));
            tr.append(enabledCell, fileCell, categoryCell, urlCell, stateCell, operations);
            tbody.append(tr);
        }
    }
    toolbar.append(
        button("扫描工作流", () => action(async () => { const result = await scanNode(node); message.textContent = result.warnings.join("\n") || "扫描完成，已保留填写的地址和手动条目。"; render(); })),
        button("添加模型", () => { manifest(node).models.push({ category: "", relative_path: "", url: "", enabled: true, source: "manual", references: [] }); changed(); render(); }),
        button("检查本地", () => action(check)),
        button("校验已有文件", () => action(() => check(true))),
        button("补齐当前选择", () => action(async () => {
            await prepare(await app.graphToPrompt(app.rootGraph ?? app.graph), undefined, true);
            await check();
        })),
    );
    const importer = element("details", "gw-import");
    importer.append(element("summary", "", "从魔搭链接批量登记"));
    const importFields = element("div", "gw-import-fields");
    const importUrl = element("input");
    importUrl.placeholder = "https://modelscope.cn/models/作者/仓库/tree/master/目录";
    importUrl.setAttribute("aria-label", "魔搭仓库或目录链接");
    const fallback = element("select");
    fallback.setAttribute("aria-label", "未识别目录的保存类别");
    for (const name of ["", ...modelCategories]) {
        const option = element("option", "", name || "未识别类别时：手动确认");
        option.value = name;
        fallback.append(option);
    }
    const importButton = button("批量登记", () => action(async () => {
        importButton.disabled = true;
        message.textContent = "正在读取魔搭目录…";
        try {
            const result = await request("/models/import", { url: importUrl.value.trim(), category: fallback.value });
            const merged = mergeImported(manifest(node).models, result.models);
            updateNode(node, merged.models);
            node.graph?.change();
            statuses.clear();
            render();
            message.textContent = `读取 ${result.models.length} 个模型，新增 ${merged.added} 项，重复 ${merged.duplicates} 项，其中补全地址或校验信息 ${merged.filled} 项。` +
                (merged.conflicts ? `\n${merged.conflicts} 项大小或哈希冲突，已保留原条目，请核对。` : "") +
                (result.warnings.length ? "\n" + result.warnings.join("\n") : "") + "\n已登记为候选，运行时只下载实际选中的模型。";
        } finally {
            importButton.disabled = false;
        }
    }));
    importFields.append(importUrl, fallback, importButton);
    importer.append(element("p", "", "读取该目录及子目录的模型，自动填写名称、下载地址、大小和 SHA256；保留已有条目，只补充空缺信息。"), importFields);
    content.append(autoLabel, element("p", "", "保存目录按当前 ComfyUI 配置自动适配，工作流只保存类别和相对子路径。"), toolbar, importer, message, scroll);
    render();
}

async function refreshCombos() {
    const values = liveNodes().flatMap(({ node }) => (node.widgets ?? []).filter(w => w.type === "combo").map(widget => ({ node, widget, value: widget.value })));
    await app.refreshComboInNodes();
    for (const { node, widget, value } of values) if (node.graph) widget.value = value;
}

function nativeValues(prompt, scanned, checked) {
    const byKey = new Map(checked.map(row => [keyOf(row), row]));
    for (const row of scanned) {
        const resolved = byKey.get(keyOf(row));
        if (!resolved) continue;
        for (const ref of row.references) {
            if (prompt[ref.node_id]?.class_type === TYPE) continue;
            const inputs = prompt[ref.node_id]?.inputs;
            if (inputs && typeof inputs[ref.input_name] === "string") inputs[ref.input_name] = resolved.loader_value;
        }
    }
}

async function prepare(data, options, manual = false) {
    const owners = serializedNodes(data.workflow).filter(node => node.type === TYPE && ![2, 4].includes(node.mode) && node.properties?.gw_manifest_enabled !== false);
    if (!owners.length) return;
    const snapshot = JSON.parse(JSON.stringify(data));
    const saved = owners.flatMap(node => manifest(node).models);
    const metadata = serializedNodes(snapshot.workflow).flatMap(node => node.properties?.models ?? []).concat(snapshot.workflow.models ?? []);
    const scan = await request("/models/scan", { prompt: snapshot.output, targets: options?.partialExecutionTargets, metadata });
    for (const row of scan.models) {
        if (!row.category) {
            const candidates = saved.filter(item => item.relative_path === row.relative_path);
            if (candidates.length === 1) row.category = candidates[0].category;
        }
    }
    const active = scan.models.map(row => {
        const previous = saved.filter(item => keyOf(item) === keyOf(row));
        return previous.length ? previous.filter(item => item.enabled !== false).map(item => ({ ...item, references: row.references })) : [row];
    }).flat();
    active.push(...saved.filter(row => row.required === true && row.enabled !== false));
    const checked = (await request("/models/check", { models: active })).models;
    const errors = checked.filter(row => ["no_url", "invalid"].includes(row.status));
    if (errors.length) throw new Error(errors.map(row => `${row.relative_path}：${row.error}`).join("\n") + "\n请打开 GW 模型依赖清单处理后重试。");
    if (checked.some(row => row.status === "missing")) {
        if (!manual && localStorage.getItem(AUTO_KEY) === "false") throw new Error("本机已关闭自动补齐。请在 GW 模型依赖面板开启“本机运行前自动补齐”，或点击“补齐当前选择”。");
        await downloadMissing(checked);
        const verified = (await request("/models/check", { models: active })).models;
        if (verified.some(row => row.status !== "exists")) throw new Error("模型补齐后检查未通过，本次任务未提交");
        await refreshCombos();
    }
    nativeValues(snapshot.output, scan.models, checked);
    return snapshot;
}

app.registerExtension({
    name: "EditingGW.ModelManifest",
    async init() {
        const link = element("link");
        link.rel = "stylesheet";
        link.href = new URL("model_manifest.css", import.meta.url).href;
        document.head.append(link);
        await request("/models/scan", { nodes: [] });
        const original = api.queuePrompt;
        api.queuePrompt = async function (...args) {
            try {
                const prepared = await prepare(args[1], args[2]);
                if (prepared) args[1] = prepared;
            } catch (error) {
                notify(error);
                throw error;
            }
            return original.apply(this, args);
        };
    },
    beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData.name !== TYPE) return;
        const created = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            created?.apply(this, arguments);
            this.properties.gw_model_manifest ??= { version: 1, models: [] };
            this.properties.gw_manifest_enabled ??= true;
            this.outputs[0].type = "COMBO";
            const selection = this.widgets.find(widget => widget.name === "selected_model");
            selection.type = "combo";
            selection.label = "选择模型";
            selection.options.values = [""];
            selection.callback = value => { this.properties.gw_selected_model = value; this.graph?.change(); };
            const stored = this.widgets.find(widget => widget.name === "manifest");
            stored.hidden = true;
            stored.options.hidden = true;
            stored.type = "hidden";
            stored.computeSize = () => [0, -4];
            stored.draw = () => {};
            stored.callback = value => {
                const saved = manifest({ properties: { gw_model_manifest: JSON.parse(value) } });
                this.properties.gw_manifest_enabled = saved.enabled !== false;
                this.enabledToggle.value = this.properties.gw_manifest_enabled;
                updateNode(this, saved.models);
            };
            this.enabledToggle = this.addWidget("toggle", "启用清单", true, value => {
                this.properties.gw_manifest_enabled = value;
                updateNode(this, manifest(this).models);
                this.graph?.change();
            }, { serialize: false });
            this.summary = this.addWidget("button", "候选模型 0 项", null, () => editNode(this), { serialize: false });
            this.addWidget("button", "扫描工作流", null, async () => { try { await scanNode(this); editNode(this); } catch (error) { notify(error); } }, { serialize: false });
            this.addWidget("button", "编辑清单 / 下载缺失", null, () => editNode(this), { serialize: false });
            updateNode(this, manifest(this).models);
            this.size = [370, 210];
        };
        const added = nodeType.prototype.onAdded;
        nodeType.prototype.onAdded = function () {
            added?.apply(this, arguments);
            setTimeout(() => {
                if (this.graph && !manifest(this).models.length) scanNode(this).catch(notify);
            }, 300);
        };
        const configured = nodeType.prototype.onConfigure;
        nodeType.prototype.onConfigure = function () {
            configured?.apply(this, arguments);
            if (!this.outputs.length) this.addOutput("模型名称", "COMBO");
            this.outputs[0].type = "COMBO";
            this.enabledToggle.value = this.properties.gw_manifest_enabled !== false;
            const selection = this.widgets.find(widget => widget.name === "selected_model");
            selection.value = this.properties.gw_selected_model ?? selection.value ?? "";
            updateNode(this, manifest(this).models);
        };
        const connectionsChanged = nodeType.prototype.onConnectionsChange;
        nodeType.prototype.onConnectionsChange = function () {
            connectionsChanged?.apply(this, arguments);
            if (this.summary) updateNode(this, manifest(this).models);
        };
        const serialized = nodeType.prototype.onSerialize;
        nodeType.prototype.onSerialize = function (info) {
            const models = manifest(this).models;
            this.properties.gw_selected_model = this.widgets.find(widget => widget.name === "selected_model").value;
            if (this.graph) updateNode(this, mergeScan(models, localScan(app.rootGraph ?? app.graph, models)));
            serialized?.apply(this, arguments);
            info.properties = JSON.parse(JSON.stringify(this.properties));
            if (info.widgets_values) info.widgets_values[this.widgets.findIndex(widget => widget.name === "manifest")] = this.widgets.find(widget => widget.name === "manifest").value;
        };
    },
    nodeCreated(node) {
        const fields = loaderRules[node.comfyClass ?? node.type];
        if (!fields) return;
        const configured = node.onConfigure;
        node.onConfigure = function (info) {
            const widgets = (this.widgets ?? []).filter(widget => widget.serialize !== false);
            loadedModelValues.set(this, widgets.flatMap((widget, index) => {
                const value = info.widgets_values?.[index];
                return widget.name in fields && typeof value === "string" ? [[widget.name, value]] : [];
            }));
            return configured?.apply(this, arguments);
        };
    },
    beforeConfigureGraph(graphData) {
        for (const node of serializedNodes(graphData)) if (node.type === TYPE) manifest(node);
    },
    afterConfigureGraph() {
        const all = liveNodes();
        const enabled = all.some(({ node }) => node.type === TYPE && ![2, 4].includes(node.mode) && node.properties?.gw_manifest_enabled !== false);
        for (const { node } of all) {
            for (const [name, value] of loadedModelValues.get(node) ?? []) {
                const widget = node.widgets?.find(widget => widget.name === name);
                if (enabled && widget && !node.inputs?.some(input => input.name === name && input.link != null)) widget.value = pathOf(value).replaceAll("/", separator);
            }
            loadedModelValues.delete(node);
            if (node.type === TYPE) updateNode(node, manifest(node).models);
        }
    },
});
