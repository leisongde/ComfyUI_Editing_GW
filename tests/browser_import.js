async (page) => {
    await page.waitForFunction(() => window.comfyAPI?.app?.app?.rootGraph && window.LiteGraph?.registered_node_types['GW/ModelManifest']);
    await page.setViewportSize({ width: 1500, height: 1000 });
    let downloads = 0;
    await page.route('**/editing_gw/downloads', async route => {
        downloads++;
        await route.fulfill({ status: 500, json: { error: 'Import must not start a download' } });
    });
    await page.evaluate(() => {
        document.querySelectorAll('dialog.gw-model-dialog').forEach(dialog => dialog.close());
        const app = window.comfyAPI.app.app;
        app.rootGraph.clear();
        const loader = LiteGraph.createNode('UNETLoader');
        app.rootGraph.add(loader);
        loader.widgets.find(widget => widget.name === 'unet_name').value = 'minimax/minimax_h3_ref2va_pruned_fp8_scaled.safetensors';
        app.rootGraph.add(LiteGraph.createNode('GW/ModelManifest'));
    });
    await page.waitForFunction(() => window.comfyAPI.app.app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest').properties.gw_model_manifest.models.length === 1);
    await page.evaluate(() => window.comfyAPI.app.app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest').widgets.find(widget => widget.name === '编辑清单 / 下载缺失').callback());
    const dialog = page.locator('dialog.gw-model-dialog');
    await dialog.locator('.gw-import summary').click();
    await dialog.getByRole('textbox', { name: '魔搭仓库或目录链接', exact: true }).fill('https://modelscope.cn/models/Comfy-Org/MiniMax-H3/tree/master/diffusion_models');
    await dialog.getByRole('button', { name: '批量登记', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.gw-message')?.textContent.includes('读取 12 个模型'));
    let models = await page.evaluate(() => window.comfyAPI.app.app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest').properties.gw_model_manifest.models);
    if (models.length !== 12 || models[0].relative_path !== 'minimax/minimax_h3_ref2va_pruned_fp8_scaled.safetensors') throw new Error('Directory import duplicated the existing loader file or changed its saved subdirectory');
    if (models.some(model => model.category !== 'diffusion_models' || !model.url || !model.sha256 || !model.size_bytes || model.required === true)) throw new Error('Imported candidates are missing metadata or would download unconditionally');
    if (!(await dialog.locator('.gw-message').textContent()).includes('新增 11 项，重复 1 项')) throw new Error('Import counts were not shown');
    console.log('PASS: the live ModelScope directory imports 12 candidates, fills the existing loader address and preserves its minimax subdirectory');

    await dialog.getByRole('button', { name: '批量登记', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.gw-message')?.textContent.includes('新增 0 项，重复 12 项'));
    if (await dialog.locator('tbody tr').count() !== 12) throw new Error('Repeated imports created duplicates');
    console.log('PASS: importing the directory again keeps the same 12 models');

    await dialog.getByRole('button', { name: '添加模型', exact: true }).click();
    const manual = dialog.locator('tbody tr').last();
    await manual.getByPlaceholder('子目录/模型.safetensors').fill('manual-test.safetensors');
    await manual.locator('td').nth(2).locator('select').first().selectOption('text_encoders');
    await manual.getByPlaceholder('https://… 模型文件直链').fill('https://example.com/manual-test.safetensors');
    await manual.locator('td').nth(0).locator('input[type=checkbox]').uncheck();
    if (!(await manual.locator('td').nth(2).textContent()).includes('保存目录：')) throw new Error('Single model entry no longer shows its local save directory');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(async () => {
        const app = window.comfyAPI.app.app;
        const data = await app.graphToPrompt();
        const node = Object.values(data.output).find(node => node.class_type === 'GW/ModelManifest');
        const catalog = JSON.parse(node.inputs.manifest);
        if (catalog.models.length !== 13 || catalog.models.at(-1).enabled !== false) throw new Error('API export lost the imported catalog or manual entry state');
        await app.loadGraphData(data.workflow);
        const manager = app.rootGraph._nodes.find(node => node.type === 'GW/ModelManifest');
        if (manager.properties.gw_model_manifest.models.length !== 13) throw new Error('Saved catalog did not survive reload');
        manager.widgets.find(widget => widget.name === '编辑清单 / 下载缺失').callback();
    });
    if (downloads) throw new Error('Registration or save/reload started a model download');
    await page.screenshot({ path: 'modelscope-import.png' });
    await page.locator('dialog.gw-model-dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.unrouteAll({ behavior: 'wait' });
    console.log('PASS: individual additions, immediate directory display, disabled state and workflow/API persistence still work, with no downloads during import');
}
