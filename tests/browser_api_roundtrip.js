async (page) => {
    await page.waitForFunction(() => window.comfyAPI?.app?.app?.rootGraph && window.LiteGraph?.registered_node_types['GW/ModelManifest']);
    await page.evaluate(async () => {
        document.querySelectorAll('dialog.gw-model-dialog').forEach(dialog => dialog.close());
        const app = window.comfyAPI.app.app;
        app.rootGraph.clear();
        const manager = LiteGraph.createNode('GW/ModelManifest');
        app.rootGraph.add(manager);
        const models = [
            { category: 'diffusion_models', relative_path: 'minimax/model-fp8.safetensors', url: 'https://example.com/model-fp8.safetensors', source: 'scan', references: [], enabled: true, sha256: 'a'.repeat(64), size_bytes: 123 },
            { category: 'text_encoders', relative_path: 'text-bf16.safetensors', url: 'https://example.com/text-bf16.safetensors', source: 'manual', references: [], enabled: false, required: true },
            { category: 'loras', relative_path: 'extra.safetensors', url: 'https://example.com/extra.safetensors', source: 'modelscope', references: [], enabled: true, required: false },
        ];
        manager.properties.gw_model_manifest.models = models;
        manager.properties.gw_manifest_enabled = false;
        const first = await app.graphToPrompt();
        const exported = JSON.parse(JSON.stringify(first.output));
        const stored = Object.values(exported).find(node => node.class_type === 'GW/ModelManifest');
        if (JSON.parse(stored.inputs.manifest).models.length !== 3) throw new Error('API export did not contain the full catalog');
        function checkCatalog(node) {
            const restored = node.properties.gw_model_manifest.models;
            if (restored.length !== models.length) throw new Error('Imported model count changed');
            for (let i = 0; i < models.length; i++) {
                for (const field of ['category', 'relative_path', 'url', 'sha256', 'size_bytes', 'source', 'enabled', 'required']) {
                    if (restored[i][field] !== models[i][field]) throw new Error('Imported model field changed: ' + field);
                }
            }
            if (node.properties.gw_manifest_enabled !== false || node.enabledToggle.value !== false) throw new Error('Manifest enable state was lost');
        }
        for (let iteration = 0; iteration < 2; iteration++) {
            await app.loadApiJson(exported, 'GW API catalog round trip');
            checkCatalog(app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest'));
            const again = await app.graphToPrompt();
            const repeated = Object.values(again.output).find(node => node.class_type === 'GW/ModelManifest');
            if (JSON.stringify(JSON.parse(repeated.inputs.manifest).models.map(model => model.url)) !== JSON.stringify(models.map(model => model.url))) throw new Error('API re-export lost URLs');
            Object.assign(exported, JSON.parse(JSON.stringify(again.output)));
        }
        const normal = JSON.parse(JSON.stringify((await app.graphToPrompt()).workflow));
        await app.loadGraphData(normal);
        const restored = app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest');
        checkCatalog(restored);
        restored.widgets.find(widget => widget.name === '编辑清单 / 下载缺失').callback();
        window.gwApiRoundTripChecks = ['API export', 'API import', 'API re-export', 'repeated API import', 'normal workflow reload', 'URLs and metadata', 'disabled states'];
    });
    const urls = await page.locator('dialog.gw-model-dialog').getByPlaceholder('https://… 模型文件直链').evaluateAll(inputs => inputs.map(input => input.value));
    if (urls.length !== 3 || urls.some(url => !url.startsWith('https://example.com/'))) throw new Error('Restored URLs were not displayed in the catalog panel');
    await page.screenshot({ path: 'api-import-restored.png' });
    await page.locator('dialog.gw-model-dialog').getByRole('button', { name: '关闭', exact: true }).click();

    await page.evaluate(async () => {
        const app = window.comfyAPI.app.app;
        const catalog = { version: 1, models: [{ category: 'diffusion_models', relative_path: 'linked-fp8.safetensors', url: 'https://example.com/linked-fp8.safetensors', enabled: true, source: 'manual', references: [] }] };
        const data = {
            '1': { class_type: 'UNETLoader', inputs: { unet_name: ['9', 0], weight_dtype: 'default' } },
            '9': { class_type: 'GW/ModelManifest', inputs: { selected_model: 'diffusion_models/linked-fp8.safetensors', manifest: JSON.stringify(catalog) } },
        };
        await app.loadApiJson(data, 'GW connected API import');
        const manager = app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest');
        if (manager.properties.gw_model_manifest.models[0]?.url !== catalog.models[0].url) throw new Error('Connected API import lost the model URL');
        if (manager.widgets.find(widget => widget.name === 'selected_model').value !== data['9'].inputs.selected_model) throw new Error('Connected model selection was lost');
        if (!manager.outputs[0].links?.length) throw new Error('Connected import lost the loader link');
        const again = await app.graphToPrompt();
        if (again.output['1'].inputs.unet_name[0] !== '9') throw new Error('Connected API re-export lost the loader link');
        window.gwApiRoundTripChecks.push('connected API import and re-export');
    });
}
