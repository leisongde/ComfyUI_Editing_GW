import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const storage = new Map();
const calls = [];
let scanModels = [];
let state = "exists";
const api = {
    async fetchApi(path, options) {
        const body = JSON.parse(options?.body ?? "{}");
        calls.push({ path, body });
        const data = path.endsWith("/scan")
            ? { models: scanModels, categories: ["diffusion_models", "loras"], loaders: { UNETLoader: { unet_name: "diffusion_models" } }, separator: "\\" }
            : { models: body.models.map(row => ({ ...row, status: state, loader_value: row.relative_path.replaceAll("/", "\\") })) };
        return { ok: true, json: async () => data };
    },
};
let extension;
const app = { registerExtension(value) { extension = value; }, rootGraph: { _nodes: [] } };
const context = vm.createContext({
    structuredClone, URL, setTimeout,
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
});
const appModule = new vm.SyntheticModule(["app"], function () { this.setExport("app", app); }, { context });
const apiModule = new vm.SyntheticModule(["api"], function () { this.setExport("api", api); }, { context });
const source = await readFile(new URL("../web/model_manifest.js", import.meta.url), "utf8");
const module = new vm.SourceTextModule(source + "\nexport { mergeScan, mergeImported, localScan, prepare, request };", { context });
await module.link(specifier => specifier.endsWith("app.js") ? appModule : apiModule);
await module.evaluate();
const { mergeScan, mergeImported, localScan, prepare, request } = module.namespace;
const row = { category: "diffusion_models", relative_path: "sub/model.safetensors", url: "https://example.com/model", source: "scan", enabled: true, references: [{ node_id: "1", input_name: "unet_name" }] };
const manual = { category: "loras", relative_path: "extra.safetensors", url: "https://example.com/extra", source: "manual", enabled: true, references: [] };

const editable = structuredClone(row);
let merged = mergeScan([editable, manual], [{ ...row, url: "", references: row.references }]);
assert.equal(merged.length, 2);
assert.equal(merged[0].url, row.url);
assert.equal(merged[1].source, "manual");
assert.equal(merged[0], editable);
merged = mergeScan(merged, []);
assert.equal(merged[0].unused, true);
assert.equal(merged[1].unused, false);
console.log("PASS: rescan preserves links and manual entries, marks removed references unused");

const imported = { ...row, relative_path: "model.safetensors", source: "modelscope", sha256: "a".repeat(64), size_bytes: 10, references: [], required: false };
const needsAddress = { ...row, url: "", enabled: false };
let batch = mergeImported([needsAddress, manual], [imported, { ...imported, relative_path: "fp8.safetensors" }]);
assert.equal(batch.added, 1);
assert.equal(batch.filled, 1);
assert.equal(batch.duplicates, 1);
assert.equal(batch.models[0].relative_path, "sub/model.safetensors");
assert.equal(batch.models[0].enabled, false);
assert.equal(batch.models[0].source, "scan");
assert.equal(batch.models[0].references, row.references);
assert.equal(batch.models[0].sha256, imported.sha256);
assert.equal(needsAddress.url, "");
batch = mergeImported(batch.models, [imported, { ...imported, relative_path: "fp8.safetensors" }]);
assert.equal(batch.added, 0);
assert.equal(batch.filled, 0);
assert.equal(batch.models.length, 3);
assert.equal(batch.models[2].required, false);
console.log("PASS: repeated batch imports deduplicate by category and unique filename, fill missing addresses and preserve saved paths and disabled state");

const differentCategory = mergeImported([manual], [{ ...imported, category: "vae", relative_path: manual.relative_path }]);
assert.equal(differentCategory.added, 1);
const ambiguous = mergeImported([{ ...needsAddress, relative_path: "a/model.safetensors" }, { ...needsAddress, relative_path: "b/model.safetensors" }], [imported]);
assert.equal(ambiguous.added, 1);
const separateNames = mergeImported([needsAddress], [{ ...imported, relative_path: "a/model.safetensors" }, { ...imported, relative_path: "b/model.safetensors" }]);
assert.equal(separateNames.added, 2);
console.log("PASS: same basenames in different categories or ambiguous subdirectories do not merge unrelated model files");

const originalHash = { ...row, sha256: "b".repeat(64) };
const conflicting = mergeImported([originalHash], [imported]);
assert.equal(conflicting.conflicts, 1);
assert.equal(conflicting.models[0].sha256, originalHash.sha256);
const differentMirror = mergeImported([row], [{ ...imported, url: "https://modelscope.cn/other-model" }]);
assert.equal(differentMirror.models[0].url, row.url);
assert.equal(differentMirror.models[0].sha256, undefined);
console.log("PASS: imports keep existing URLs and do not mix conflicting verification data from another artifact");

await request("/models/scan", { nodes: [] });
app.rootGraph._nodes = [{ id: 1, type: "UNETLoader", widgets: [{ name: "unet_name", value: "sub\\model.safetensors" }] }];
assert.equal(localScan(app.rootGraph, [row])[0].relative_path, row.relative_path);
assert.equal(localScan(app.rootGraph, [row])[0].category, "diffusion_models");
console.log("PASS: local serialization scan handles native Windows paths");

const linkedGraph = {
    _nodes: [], links: new Map([[3, { origin_id: 2 }]]),
    getNodeById(id) { return this._nodes.find(node => node.id === id); },
};
linkedGraph._nodes = [
    { id: 1, type: "UNETLoader", graph: linkedGraph, inputs: [{ name: "unet_name", link: 3 }] },
    { id: 2, type: "PrimitiveNode", graph: linkedGraph, widgets: [{ name: "value", value: "sub/model.safetensors" }] },
];
assert.equal(localScan(linkedGraph, [row])[0].relative_path, row.relative_path);
linkedGraph._nodes[1].type = "DynamicFilename";
assert.equal(localScan(linkedGraph, [row])[0].references[0].input_name, "unet_name");
console.log("PASS: linked Primitive values scan correctly and unresolved linked references survive serialization");

const workflow = { nodes: [{ id: 9, type: "GW/ModelManifest", mode: 0, properties: { gw_model_manifest: { version: 1, models: [row] } } }] };
const data = { workflow, output: { "1": { class_type: "UNETLoader", inputs: { unet_name: row.relative_path } }, "2": { class_type: "Sampler", inputs: { seed: 123 } } } };
scanModels = [{ ...row, url: "" }];
const prepared = await prepare(data);
assert.equal(prepared.output["1"].inputs.unet_name, "sub\\model.safetensors");
assert.equal(data.output["1"].inputs.unet_name, row.relative_path);
assert.equal(prepared.output["2"].inputs.seed, 123);
assert.equal(calls.some(call => call.path.endsWith("/downloads")), false);
console.log("PASS: existing files skip downloads and preserve prompt snapshot and seed");

const reactiveData = new Proxy({
    workflow: new Proxy(data.workflow, {}),
    output: new Proxy(data.output, {}),
}, {});
const reactivePrepared = await prepare(reactiveData);
assert.equal(reactivePrepared.output["1"].inputs.unet_name, "sub\\model.safetensors");
assert.equal(reactiveData.output["1"].inputs.unet_name, row.relative_path);
assert.equal(reactivePrepared.output["2"].inputs.seed, 123);
assert.notEqual(reactivePrepared.workflow, reactiveData.workflow);
console.log("PASS: reactive workflow and prompt objects produce an independent submission snapshot");

class ManifestNode {}
extension.beforeRegisterNodeDef(ManifestNode, { name: "GW/ModelManifest" });
const reactiveProperties = new Proxy({
    gw_model_manifest: new Proxy({ version: 1, models: new Proxy([new Proxy({ ...row }, {})], {}) }, {}),
    gw_manifest_enabled: true,
}, {});
const savedInfo = {};
ManifestNode.prototype.onSerialize.call({ properties: reactiveProperties, widgets: [{ name: "selected_model", value: "" }] }, savedInfo);
assert.equal(savedInfo.properties.gw_model_manifest.models[0].url, row.url);
assert.equal(savedInfo.properties.gw_manifest_enabled, true);
savedInfo.properties.gw_model_manifest.models[0].url = "https://example.com/changed";
assert.equal(reactiveProperties.gw_model_manifest.models[0].url, row.url);
console.log("PASS: reactive node properties and nested model rows serialize without sharing mutable state");

const apiImported = Object.assign(new ManifestNode(), {
    properties: {}, outputs: [{}],
    widgets: [{ name: "selected_model", value: "", options: {} }, { name: "manifest", options: {} }],
    addWidget(type, name, value, callback, options) {
        const widget = { type, name, value, callback, options };
        this.widgets.push(widget);
        return widget;
    },
    setDirtyCanvas() {},
});
apiImported.onNodeCreated();
const apiSelection = apiImported.widgets.find(widget => widget.name === "selected_model");
const apiManifest = apiImported.widgets.find(widget => widget.name === "manifest");
apiSelection.value = "diffusion_models/" + row.relative_path;
apiSelection.callback(apiSelection.value);
const apiCatalog = { version: 1, enabled: false, models: [
    { ...row, sha256: "a".repeat(64), size_bytes: 42 },
    { ...manual, enabled: false, required: true },
    { ...imported, relative_path: "candidate-fp8.safetensors" },
] };
apiManifest.value = JSON.stringify(apiCatalog);
apiManifest.callback(apiManifest.value);
assert.equal(apiImported.properties.gw_model_manifest.models[0].url, row.url);
assert.equal(apiImported.properties.gw_model_manifest.models[0].sha256, apiCatalog.models[0].sha256);
assert.equal(apiImported.properties.gw_model_manifest.models[1].enabled, false);
assert.equal(apiImported.properties.gw_model_manifest.models[1].required, true);
assert.equal(apiImported.properties.gw_model_manifest.models[2].source, "modelscope");
assert.equal(apiImported.properties.gw_manifest_enabled, false);
assert.equal(apiImported.enabledToggle.value, false);
assert.equal(apiSelection.value, "diffusion_models/" + row.relative_path);
const reexport = { widgets_values: [apiSelection.value, apiManifest.value] };
apiImported.onSerialize(reexport);
assert.equal(reexport.properties.gw_model_manifest.models.length, 3);
assert.equal(JSON.parse(reexport.widgets_values[1]).models[0].url, row.url);
apiManifest.callback(reexport.widgets_values[1]);
assert.equal(apiImported.properties.gw_model_manifest.models[0].url, row.url);
console.log("PASS: API import restores URLs, candidate metadata, selected model and enabled states before serialization and re-export");
assert.throws(() => apiManifest.callback('{"version":2,"models":[]}'), /不支持/);
assert.equal(apiImported.properties.gw_model_manifest.models[0].url, row.url);
console.log("PASS: invalid API manifests fail without replacing the current catalog");

state = "missing";
storage.set("ComfyUI.EditingGW.AutoDownload", "false");
await assert.rejects(() => prepare(data), /自动补齐/);
assert.equal(calls.some(call => call.path.endsWith("/downloads")), false);
storage.delete("ComfyUI.EditingGW.AutoDownload");
console.log("PASS: explicitly disabling automatic downloads prevents starting missing downloads");

state = "exists";
const disabled = structuredClone(data);
disabled.workflow.nodes[0].properties.gw_model_manifest.models[0].enabled = false;
await prepare(disabled);
assert.equal(calls.at(-1).body.models.length, 0);
console.log("PASS: disabled manifest entries are not silently re-enabled by scanning");

const candidates = structuredClone(data);
const chosen = { ...row, relative_path: "model-fp8.safetensors", source: "manual", unused: true, references: [] };
candidates.workflow.nodes[0].properties.gw_model_manifest.models = [
    { ...row, unused: true }, chosen,
    { ...manual, relative_path: "unselected.safetensors", url: "" },
];
candidates.output["9"] = { class_type: "GW/ModelManifest", inputs: { selected_model: "diffusion_models/model-fp8.safetensors", manifest: JSON.stringify(candidates.workflow.nodes[0].properties.gw_model_manifest) } };
candidates.output["1"].inputs.unet_name = ["9", 0];
scanModels = [{ ...chosen, references: [{ node_id: "9", input_name: "selected_model" }] }];
const selected = await prepare(candidates);
assert.equal(calls.at(-1).body.models.length, 1);
assert.equal(calls.at(-1).body.models[0].relative_path, chosen.relative_path);
assert.equal(selected.output["9"].inputs.selected_model, "diffusion_models/model-fp8.safetensors");
assert.deepEqual(Array.from(selected.output["1"].inputs.unet_name), ["9", 0]);
console.log("PASS: registered candidates download only when chosen and connected selections remain intact");

candidates.workflow.nodes[0].properties.gw_model_manifest.models.push({ ...manual, required: true });
await prepare(candidates);
assert.equal(calls.at(-1).body.models.length, 2);
assert.equal(calls.at(-1).body.models[1].required, true);
console.log("PASS: only explicitly required extra files join the chosen model plan");

const loader = { type: "UNETLoader", widgets: [{ name: "unet_name", value: "fallback.safetensors" }], onConfigure() { this.widgets[0].value = "fallback.safetensors"; } };
const manager = {
    type: "GW/ModelManifest", properties: { gw_model_manifest: { version: 1, models: [row] } },
    widgets: [{ name: "selected_model", options: {} }, { name: "manifest" }], outputs: [{ links: [] }],
    summary: {}, setDirtyCanvas() {},
};
extension.nodeCreated(loader);
loader.onConfigure({ widgets_values: ["software/model-fp8.safetensors"] });
app.rootGraph._nodes = [loader, manager];
extension.afterConfigureGraph();
assert.equal(loader.widgets[0].value, "software\\model-fp8.safetensors");
assert.equal(manager.widgets[0].hidden, true);
assert.match(manager.summary.name, /无需连线/);
console.log("PASS: loading restores the actual saved loader input instead of a stale manifest selection");

loader.onConfigure({ widgets_values: ["software/model-fp8.safetensors"] });
app.rootGraph._nodes = [loader];
extension.afterConfigureGraph();
assert.equal(loader.widgets[0].value, "fallback.safetensors");
console.log("PASS: loading a workflow without a manifest retains the normal loader behavior");

calls.length = 0;
assert.equal(await prepare({ workflow: { nodes: [] }, output: {} }), undefined);
assert.equal(calls.length, 0);
console.log("PASS: workflows without the management node do not call plugin APIs");
