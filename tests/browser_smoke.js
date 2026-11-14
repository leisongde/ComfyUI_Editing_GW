async (page) => {
    await page.unrouteAll({ behavior: 'wait' });
    await page.waitForFunction(() => window.comfyAPI?.app?.app?.rootGraph && window.LiteGraph?.registered_node_types['GW/ModelManifest']);
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.evaluate(() => {
        document.querySelectorAll('dialog.gw-model-dialog').forEach(dialog => dialog.close());
        const app = window.comfyAPI.app.app;
        app.rootGraph.clear();
        const loader = LiteGraph.createNode('UNETLoader');
        app.rootGraph.add(loader);
        loader.widgets.find(widget => widget.name === 'unet_name').value = 'ui_test/gw-ui-missing.safetensors';
        const manager = LiteGraph.createNode('GW/ModelManifest');
        manager.properties = new Proxy(manager.properties, {});
        app.rootGraph.add(manager);
        loader.pos = [80, 100];
        manager.pos = [500, 100];
        app.canvas.ds.scale = 1;
        app.canvas.ds.offset = [0, 0];
    });
    await page.waitForFunction(() => window.comfyAPI.app.app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest').properties.gw_model_manifest.models.length === 1);
    await page.evaluate(() => {
        window.comfyAPI.app.app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest').widgets.find(widget => widget.name === '编辑清单 / 下载缺失').callback();
    });
    const dialog = page.locator('dialog.gw-model-dialog');
    const rows = dialog.locator('tbody tr');
    if (await rows.count() !== 1) throw new Error('Expected one scanned dependency');
    await rows.nth(0).getByPlaceholder('https://… 模型文件直链').fill('https://example.com/gw-ui-missing.safetensors');
    await dialog.getByRole('button', { name: '添加模型', exact: true }).click();
    await rows.nth(1).getByPlaceholder('子目录/模型.safetensors').fill('styles/gw-extra.safetensors');
    await rows.nth(1).locator('td').nth(2).locator('select').selectOption('loras');
    await rows.nth(1).locator('td').nth(0).locator('select').selectOption('required');
    await rows.nth(1).getByPlaceholder('https://… 模型文件直链').fill('https://example.com/gw-extra.safetensors');
    await dialog.getByRole('button', { name: '检查本地', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.gw-message')?.textContent.includes('共 2 项'));
    if (await dialog.getByText('缺失', { exact: true }).count() !== 2) throw new Error('Expected two missing model statuses');
    await dialog.getByRole('checkbox', { name: '本机运行前自动补齐缺失模型' }).check();
    await page.screenshot({ path: 'manifest-panel.png' });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    const saved = await page.evaluate(async () => {
        const app = window.comfyAPI.app.app;
        const data = await app.graphToPrompt();
        const manager = data.workflow.nodes.find(node => node.type === 'GW/ModelManifest');
        if (!Object.values(data.output).some(node => node.class_type === 'GW/ModelManifest' && JSON.parse(node.inputs.manifest).models.length === 2)) throw new Error('Manager catalog missing from API prompt');
        if (JSON.stringify(manager).includes('target_path') || JSON.stringify(manager).includes('AutoDownload')) throw new Error('Local state leaked into saved workflow');
        if (manager.properties.models.length !== 2) throw new Error('Native model metadata was not exported');
        await app.loadGraphData(data.workflow);
        return data.workflow;
    });
    const restored = await page.evaluate(() => {
        const graph = window.comfyAPI.app.app.rootGraph;
        const manager = graph._nodes.find(node => node.type === 'GW/ModelManifest');
        const loader = graph._nodes.find(node => node.type === 'UNETLoader');
        return { models: manager.properties.gw_model_manifest.models, selected: loader.widgets.find(widget => widget.name === 'unet_name').value };
    });
    if (restored.models.length !== 2 || restored.models[0].url !== 'https://example.com/gw-ui-missing.safetensors') throw new Error('Manifest did not survive save and reload');
    if (restored.selected.replaceAll('\\', '/') !== 'ui_test/gw-ui-missing.safetensors') throw new Error('Missing model selection was replaced during reload');
    console.log('PASS: real scan, editing, manual additions, local check, native metadata and workflow reload');

    let installed = false;
    let failure = false;
    let cancelling = false;
    let cancellationRequested = false;
    const events = [];
    let captured;
    let requestedModels;
    await page.route('**/editing_gw/models/check', async route => {
        const body = route.request().postDataJSON();
        events.push('check');
        await route.fulfill({ json: { models: body.models.map(row => ({ ...row, status: installed ? 'exists' : 'missing', loader_value: row.relative_path.replaceAll('/', '\\'), target_path: 'test-root/' + row.relative_path })) } });
    });
    await page.route('**/editing_gw/downloads', async route => {
        events.push('download');
        requestedModels = route.request().postDataJSON().models;
        await route.fulfill({ json: { id: 'gw-smoke', status: 'queued', files: [] } });
    });
    await page.route('**/editing_gw/downloads/gw-smoke', async route => {
        events.push('status');
        installed = !failure && !cancelling;
        await route.fulfill({ json: { id: 'gw-smoke', status: cancelling ? cancellationRequested ? 'cancelled' : 'running' : failure ? 'failed' : 'complete', files: [], ...(failure ? { error: 'Test download failure' } : {}) } });
    });
    await page.route('**/editing_gw/downloads/gw-smoke/cancel', async route => {
        cancellationRequested = true;
        await route.fulfill({ json: { id: 'gw-smoke', status: 'cancelled', files: [] } });
    });
    await page.route('**/prompt', async route => {
        events.push('prompt');
        captured = route.request().postDataJSON();
        await route.fulfill({ json: { prompt_id: '310c2cdc-1a44-4a50-8110-fb25430cbe3d', number: 0, node_errors: {} } });
    });
    const data = {
        workflow: saved,
        output: {
            '1': { class_type: 'UNETLoader', inputs: { unet_name: 'ui_test/gw-ui-missing.safetensors', weight_dtype: 'default' } },
            '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'GW-test' } },
        },
    };
    const invoke = data => page.evaluate(async data => {
        const { api } = await import('/scripts/api.js');
        data = new Proxy({ ...data, workflow: new Proxy(data.workflow, {}), output: new Proxy(data.output, {}) }, {});
        try { await api.queuePrompt(0, data); return { ok: true }; }
        catch (error) { return { ok: false, error: error.message }; }
    }, data);
    let result = await invoke(data);
    if (!result.ok) throw new Error(result.error);
    if (events.join(',') !== 'check,download,status,check,prompt') throw new Error('Incorrect download/queue order: ' + events.join(','));
    if (captured.prompt['1'].inputs.unet_name !== 'ui_test\\gw-ui-missing.safetensors') throw new Error('Native filename was not used in final prompt');
    console.log('PASS: automatic download finishes and verifies before submitting the captured prompt');

    events.length = 0;
    await invoke(data);
    if (events.join(',') !== 'check,prompt') throw new Error('Existing models caused a download');
    console.log('PASS: existing models skip the download service');

    installed = false;
    failure = true;
    events.length = 0;
    result = await invoke(data);
    if (result.ok || events.includes('prompt')) throw new Error('Failed download submitted a prompt');
    await page.evaluate(() => document.querySelectorAll('dialog.gw-model-dialog').forEach(dialog => dialog.close()));
    console.log('PASS: download failure blocks generation');

    failure = false;
    cancelling = true;
    events.length = 0;
    const pending = invoke(data);
    await page.getByRole('button', { name: '取消下载', exact: true }).click();
    result = await pending;
    if (result.ok || events.includes('prompt') || !cancellationRequested) throw new Error('Cancellation did not stop submission');
    await page.evaluate(() => document.querySelectorAll('dialog.gw-model-dialog').forEach(dialog => dialog.close()));
    console.log('PASS: cancelling through the real progress dialog blocks generation');

    events.length = 0;
    result = await invoke({ workflow: { nodes: [] }, output: {} });
    if (!result.ok || events.join(',') !== 'prompt') throw new Error('Workflow without a manager did not pass through');
    console.log('PASS: workflows without a manager retain the normal submission path');

    installed = false;
    failure = false;
    cancelling = false;
    events.length = 0;
    await page.evaluate(() => {
        const app = window.comfyAPI.app.app;
        app.rootGraph.clear();
        const vae = LiteGraph.createNode('VAELoader');
        const latent = LiteGraph.createNode('EmptyLatentImage');
        const decode = LiteGraph.createNode('VAEDecode');
        const save = LiteGraph.createNode('SaveImage');
        const manager = LiteGraph.createNode('GW/ModelManifest');
        for (const [index, node] of [vae, latent, decode, save, manager].entries()) {
            app.rootGraph.add(node);
            node.pos = [60 + index * 280, 100];
        }
        vae.widgets.find(widget => widget.name === 'vae_name').value = 'gw-real-run.safetensors';
        latent.connect(0, decode, 0);
        vae.connect(0, decode, 1);
        decode.connect(0, save, 0);
        manager.properties.gw_model_manifest.models = [{ category: 'vae', relative_path: 'gw-real-run.safetensors', url: 'https://example.com/gw-real-run.safetensors', source: 'scan', enabled: true, references: [{ node_id: String(vae.id), input_name: 'vae_name' }] }];
    });
    const prompted = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/prompt'));
    await page.getByRole('button', { name: '运行', exact: true }).first().click();
    await prompted;
    if (events.join(',') !== 'check,download,status,check,prompt') throw new Error('Real Run button bypassed preflight: ' + events.join(','));
    if (!Object.values(captured.prompt).some(node => node.class_type === 'VAELoader' && node.inputs.vae_name === 'gw-real-run.safetensors')) throw new Error('Run button changed the selected model');
    console.log('PASS: the actual ComfyUI Run button reaches preflight and submits after model preparation');

    installed = false;
    events.length = 0;
    const softwareData = await page.evaluate(async () => {
        const app = window.comfyAPI.app.app;
        const graph = app.rootGraph;
        const manager = graph._nodes.find(node => node.type === 'GW/ModelManifest');
        const loader = graph._nodes.find(node => node.type === 'VAELoader');
        loader.widgets.find(widget => widget.name === 'vae_name').value = 'gw-bf16.safetensors';
        manager.properties.gw_model_manifest.models = [
            { category: 'vae', relative_path: 'gw-bf16.safetensors', url: 'https://example.com/bf16', source: 'scan', enabled: true, references: [{ node_id: String(loader.id), input_name: 'vae_name' }] },
            { category: 'vae', relative_path: 'gw-fp8.safetensors', url: 'https://example.com/fp8', source: 'manual', enabled: true, references: [] },
            { category: 'vae', relative_path: 'gw-unused.safetensors', url: '', source: 'manual', enabled: true, references: [] },
        ];
        const selection = manager.widgets.find(widget => widget.name === 'selected_model');
        selection.value = 'vae/gw-bf16.safetensors';
        selection.callback(selection.value);
        const saved = await app.graphToPrompt();
        const savedLoader = saved.workflow.nodes.find(node => node.type === 'VAELoader');
        savedLoader.widgets_values[0] = 'gw-fp8.safetensors';
        await app.loadGraphData(saved.workflow);
        const restored = app.rootGraph._nodes.find(node => node.type === 'VAELoader');
        const restoredManager = app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest');
        if (restored.widgets.find(widget => widget.name === 'vae_name').value !== 'gw-fp8.safetensors') throw new Error('Stale catalog overwrote the software-selected model');
        if (!restoredManager.widgets.find(widget => widget.name === 'selected_model').hidden) throw new Error('Unconnected node should hide its optional selector');
        return app.graphToPrompt();
    });
    if (events.includes('download')) throw new Error('Loading the changed workflow started a download');
    console.log('PASS: software updates to loader names survive reload while the unconnected selector stays hidden');
    result = await invoke(softwareData);
    if (!result.ok) throw new Error(result.error);
    if (requestedModels.length !== 1 || requestedModels[0].relative_path !== 'gw-fp8.safetensors') throw new Error('Unconnected catalog did not follow the final fp8 loader selection');
    if (events.join(',') !== 'check,download,status,check,prompt') throw new Error('Unconnected preflight did not finish before submission');
    if (Object.values(captured.prompt).find(node => node.class_type === 'VAELoader').inputs.vae_name !== 'gw-fp8.safetensors') throw new Error('Final loader input was overwritten');
    console.log('PASS: unconnected catalog prepares only the software-selected fp8 model before submitting unchanged input');
    installed = false;
    events.length = 0;
    const loaderId = Object.keys(softwareData.output).find(id => softwareData.output[id].class_type === 'VAELoader');
    softwareData.output[loaderId].inputs.vae_name = 'gw-bf16.safetensors';
    result = await invoke(softwareData);
    if (!result.ok || requestedModels.length !== 1 || requestedModels[0].relative_path !== 'gw-bf16.safetensors') throw new Error('Runtime loader selection was ignored in favor of workflow metadata');
    console.log('PASS: runtime prompt fields override older workflow metadata without wiring');
    await page.unrouteAll({ behavior: 'wait' });
    return { passed: 10, screenshot: 'manifest-panel.png', externalModelDownloads: 0 };
}
