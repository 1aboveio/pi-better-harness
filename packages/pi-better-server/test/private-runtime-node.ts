import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const PINNED_NODE_VERSION = "24.14.1";

// The test runner may use Node 22; managed fixtures must execute the private pin.
export function privateRuntimeNode(executable = process.env.PI_TEST_PRIVATE_RUNTIME_NODE ?? process.execPath) {
  let node: string, actual: string;
  try {
    node = realpathSync(executable);
    actual = execFileSync(node, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch (cause) {
    throw new Error(`Cannot execute private test Node at ${executable}. Set PI_TEST_PRIVATE_RUNTIME_NODE to a Node ${PINNED_NODE_VERSION} binary.`, { cause });
  }
  if (actual !== `v${PINNED_NODE_VERSION}`) {
    throw new Error(`Private test Node at ${node} is ${actual}; expected v${PINNED_NODE_VERSION}. Set PI_TEST_PRIVATE_RUNTIME_NODE to the pinned binary.`);
  }
  return { node, version: PINNED_NODE_VERSION };
}
