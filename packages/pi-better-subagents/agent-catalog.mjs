#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export async function runCli(args = process.argv.slice(2), input = () => readFileSync(0, 'utf8')) {
    if (args.includes('--help')) {
        console.log('pi-agent-catalog [resolve-workers] < request.json\nResolves shared agent roles against explicit host model and effort capabilities. No workers are launched.');
        return 0;
    }
    if (args.length > 1 || (args.length === 1 && args[0] !== 'resolve-workers')) {
        console.error('Usage: pi-agent-catalog [resolve-workers] < request.json');
        return 2;
    }
    try {
        // Register only for this import. The portable resolver never loads Pi extensions or credentials.
        const { tsImport } = await import('tsx/esm/api');
        const { planWorkers } = await tsImport('./worker-catalog.ts', import.meta.url);
        const text = input();
        if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('worker request exceeds 1 MiB');
        console.log(JSON.stringify(planWorkers(JSON.parse(text))));
        return 0;
    } catch (error) {
        console.error(`pi-agent-catalog: ${error.message}`);
        console.log(JSON.stringify({ version: 1, ok: false, code: 'worker-catalog-error', reason: error.message }));
        return 2;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) process.exitCode = await runCli();