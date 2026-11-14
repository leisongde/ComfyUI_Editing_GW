async (page) => {
    await page.unrouteAll({ behavior: 'wait' });
    await page.waitForFunction(() => window.LiteGraph?.registered_node_types['GW/ModelManifest']);
    await page.setViewportSize({ width: 1600, height: 1000 });
    let downloads = [];
    const installed = new Set();
    let captured;
    await page.route('**/editing_gw/downloads', async route => {
        const models = route.request().postDataJSON().models;
        downloads.push(models.map(model => model.relative_path));
        for (const model of models) installed.add(model.relative_path);
        await route.fulfill({ json: { id: 'gw-selection', status: 'queued', files: [] } });
    });
    await page.route('**/editing_gw/downloads/gw-selection', route => route.fulfill({ json: { id: 'gw-selection', status: 'complete', files: [] } }));
    await page.route('**/editing_gw/models/check', async route => {
        const body = route.request().postDataJSON();
        await route.fulfill({ json: { models: body.models.map(model => ({
            ...model, status: installed.has(model.relative_path) ? 'exists' : model.url ? 'missing' : 'no_url',
            loader_value: model.relative_path.replaceAll('/', '\\'),
        })) } });
    });
    await page.route('**/prompt', async route => {
        captured = route.request().postDataJSON();
        await route.fulfill({ json: { prompt_id: '310c2cdc-1a44-4a50-8110-fb25430cbe3d', number: 0, node_errors: {} } });
    });
    await page.evaluate(() => {
        document.querySelectorAll('dialog.gw-model-dialog').forEach(dialog => dialog.close());
        const app = window.comfyAPI.app.app;
        app.rootGraph.clear();
        const loader = LiteGraph.createNode('VAELoader');
        const latent = LiteGraph.createNode('EmptyLatentImage');
        const decode = LiteGraph.createNode('VAEDecode');
        const save = LiteGraph.createNode('SaveImage');
        const manager = LiteGraph.createNode('GW/ModelManifest');
        const positions = [[80, 150], [550, 150], [550, 390], [900, 150], [1200, 150]];
        for (const [index, node] of [manager, loader, latent, decode, save].entries()) {
            app.rootGraph.add(node);
            node.pos = positions[index];
        }
        loader.widgets.find(widget => widget.name === 'vae_name').value = 'gw-bf16.safetensors';
        latent.connect(0, decode, 0);
        loader.connect(0, decode, 1);
        decode.connect(0, save, 0);
        app.canvas.ds.scale = 0.9;
        app.canvas.ds.offset = [0, 0];
    });
    await page.waitForFunction(() => window.comfyAPI.app.app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest').properties.gw_model_manifest.models.length === 1);
    await page.evaluate(() => window.comfyAPI.app.app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest').widgets.find(widget => widget.name === '编辑清单 / 下载缺失').callback());
    const dialog = page.locator('dialog.gw-model-dialog');
    const rows = dialog.locator('tbody tr');
    await rows.nth(0).getByPlaceholder('https://… 模型文件直链').fill('https://example.com/gw-bf16.safetensors');
    await dialog.getByRole('button', { name: '添加模型', exact: true }).click();
    await rows.nth(1).getByPlaceholder('子目录/模型.safetensors').fill('gw-fp8.safetensors');
    await rows.nth(1).locator('td').nth(2).locator('select').selectOption('vae');
    await rows.nth(1).getByPlaceholder('https://… 模型文件直链').fill('https://example.com/gw-fp8.safetensors');
    await dialog.getByRole('button', { name: '添加模型', exact: true }).click();
    await rows.nth(2).getByPlaceholder('子目录/模型.safetensors').fill('unselected-without-url.safetensors');
    await rows.nth(2).locator('td').nth(2).locator('select').selectOption('vae');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(() => {
        const graph = window.comfyAPI.app.app.rootGraph;
        const node = graph._nodes.find(node => node.type === 'GW/ModelManifest');
        const loader = graph._nodes.find(node => node.type === 'VAELoader');
        const selection = node.widgets.find(widget => widget.name === 'selected_model');
        if (!node.widgets.find(widget => widget.name === 'manifest').hidden) throw new Error('Internal manifest widget is visible');
        if (!selection.options.values.includes('vae/gw-fp8.safetensors')) throw new Error('Missing candidate not available in selector');
        selection.value = 'vae/gw-fp8.safetensors';
        selection.callback(selection.value);
        const input = loader.inputs.findIndex(input => input.name === 'vae_name');
        if (!node.connect(0, loader, input)) throw new Error('Model output cannot connect to loader combo');
    });
    let data = await page.evaluate(async () => {
        const app = window.comfyAPI.app.app;
        const data = await app.graphToPrompt();
        const [id, node] = Object.entries(data.output).find(([, node]) => node.class_type === 'GW/ModelManifest');
        if (node.inputs.selected_model !== 'vae/gw-fp8.safetensors') throw new Error('Selection missing in API export');
        if (JSON.parse(node.inputs.manifest).models.length !== 3) throw new Error('Catalog missing in API export');
        const loader = Object.values(data.output).find(node => node.class_type === 'VAELoader');
        if (loader.inputs.vae_name[0] !== id) throw new Error('Connection missing in API export');
        await app.loadGraphData(data.workflow);
        return app.graphToPrompt();
    });
    const restored = Object.values(data.output).find(node => node.class_type === 'GW/ModelManifest');
    if (restored.inputs.selected_model !== 'vae/gw-fp8.safetensors') throw new Error('Selection changed during reload');
    if (downloads.length) throw new Error('Saving or opening started a download');
    console.log('PASS: candidate registration, native loader connection, API export, save and reload without downloading');

    const invoke = data => page.evaluate(async data => {
        const { api } = await import('/scripts/api.js');
        await api.queuePrompt(0, data);
    }, data);
    await invoke(data);
    if (JSON.stringify(downloads) !== JSON.stringify([['gw-fp8.safetensors']])) throw new Error('Unselected candidates were downloaded: ' + JSON.stringify(downloads));
    if (Object.values(captured.prompt).find(node => node.class_type === 'GW/ModelManifest').inputs.selected_model !== 'vae/gw-fp8.safetensors') throw new Error('Preflight corrupted the selected model key');
    console.log('PASS: fp8 selection downloads fp8 only; missing URLs on other candidates do not block');
    await invoke(data);
    if (downloads.length !== 1) throw new Error('Existing selected model downloaded again');
    console.log('PASS: existing selected files skip downloads');
    data = await page.evaluate(async () => {
        const app = window.comfyAPI.app.app;
        const node = app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest');
        const selection = node.widgets.find(widget => widget.name === 'selected_model');
        selection.value = 'vae/gw-bf16.safetensors';
        selection.callback(selection.value);
        return app.graphToPrompt();
    });
    await invoke(data);
    if (JSON.stringify(downloads) !== JSON.stringify([['gw-fp8.safetensors'], ['gw-bf16.safetensors']])) throw new Error('Switching precision did not select the corresponding download');
    console.log('PASS: switching to bf16 downloads only the newly selected version');
    await page.screenshot({ path: 'model-selection.png' });
    await page.evaluate(async () => {
        const app = window.comfyAPI.app.app;
        const node = app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest');
        node.disconnectOutput(0);
        const data = await app.graphToPrompt();
        const oldNode = data.workflow.nodes.find(node => node.type === 'GW/ModelManifest');
        oldNode.outputs = [];
        delete oldNode.widgets_values;
        delete oldNode.properties.gw_selected_model;
        await app.loadGraphData(data.workflow);
        const restored = app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest');
        if (restored.outputs[0]?.type !== 'COMBO' || restored.properties.gw_model_manifest.models.length !== 3) throw new Error('Old virtual workflow did not gain a model output while preserving the catalog');
    });
    if (downloads.length !== 2) throw new Error('Restoring old workflow started a download');
    console.log('PASS: old workflows preserve their catalog and gain the model output');
    await page.unrouteAll({ behavior: 'wait' });
    return { passed: 5, externalModelDownloads: 0, screenshot: 'model-selection.png' };
}
