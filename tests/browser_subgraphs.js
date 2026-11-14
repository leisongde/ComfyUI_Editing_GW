async (page) => {
    await page.unrouteAll({ behavior: 'wait' });
    const results = [];
    for (const managerInside of [false, true]) {
        await page.evaluate(managerInside => {
            document.querySelectorAll('dialog.gw-model-dialog').forEach(dialog => dialog.close());
            const graph = window.comfyAPI.app.app.rootGraph;
            graph.clear();
            const loader = LiteGraph.createNode('UNETLoader');
            graph.add(loader);
            loader.widgets.find(widget => widget.name === 'unet_name').value = 'subgraph/gw-model.safetensors';
            const manager = LiteGraph.createNode('GW/ModelManifest');
            graph.add(manager);
            graph.convertToSubgraph(new Set(managerInside ? [loader, manager] : [loader]));
        }, managerInside);
        await page.evaluate(async () => {
            const graph = window.comfyAPI.app.app.rootGraph;
            const subgraph = graph._nodes.find(node => node.subgraph).subgraph;
            const manager = [...graph._nodes, ...subgraph._nodes].find(node => node.type === 'GW/ModelManifest');
            await manager.widgets.find(widget => widget.name === '扫描工作流').callback();
        });
        const dialog = page.locator('dialog.gw-model-dialog');
        if (await dialog.locator('tbody tr').count() !== 1) throw new Error('Subgraph dependency was missed or duplicated');
        await dialog.getByPlaceholder('https://… 模型文件直链').fill('https://example.com/subgraph-model.safetensors');
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        const result = await page.evaluate(async () => {
            const app = window.comfyAPI.app.app;
            const data = await app.graphToPrompt();
            if (!Object.values(data.output).some(node => node.class_type === 'GW/ModelManifest')) throw new Error('Subgraph manager missing from API prompt');
            await app.loadGraphData(data.workflow);
            const graph = app.rootGraph;
            const subgraph = graph._nodes.find(node => node.subgraph).subgraph;
            const manager = [...graph._nodes, ...subgraph._nodes].find(node => node.type === 'GW/ModelManifest');
            const row = manager.properties.gw_model_manifest.models[0];
            const selected = subgraph._nodes.find(node => node.type === 'UNETLoader').widgets.find(widget => widget.name === 'unet_name').value;
            if (row.unused || row.url !== 'https://example.com/subgraph-model.safetensors' || selected.replaceAll('\\', '/') !== row.relative_path) throw new Error('Subgraph manifest did not survive reload');
            return { references: row.references, compiledIds: Object.keys(data.output) };
        });
        results.push({ managerInside, ...result });
    }
    return { passed: results.length, results };
}
