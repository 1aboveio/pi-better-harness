/** Trusted in-process launch kernel fixture. This is NOT runtime acceptance:
 * it replaces the server adapter and worker executable, never socket admission. */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { nextRunId, listMetas, processStartToken } from '../registry.ts';
import { loadLaunchSnapshot } from '../catalog-runtime.ts';
import { getSharedCapacityGate } from '../capacity.mjs';
export function managedDomainPort(registeredTools = () => []) {
    const owner = { pid: process.pid, start: processStartToken(process.pid) };
    return {
        // These kernel fixtures load no Background extension by default. A test
        // that loads it must supply its actual registered tool inventory.
        backgroundTools: () => registeredTools().map(tool => typeof tool === "string" ? tool : tool.name),
        owner, identity: { root: process.env.PI_CODING_AGENT_DIR, instance: 'domain-test', epoch: 1 },
        supervised: () => listMetas().filter(meta => meta.spawnPid === owner.pid),
        owns: meta => meta.spawnPid === owner.pid,
        assertCurrent() {}, capacity: getSharedCapacityGate,
        snapshot: async host => loadLaunchSnapshot(host), attempt: nextRunId,
        beforeSpawn: () => ({}), spawned() {},
        workerCommand: args => ({ file: process.execPath, fileArgs: [fileURLToPath(new URL('../child-runtime.mjs', import.meta.url)), execFileSync('which', ['pi'], { encoding: 'utf8' }).trim(), ...args] }),
    };
}
