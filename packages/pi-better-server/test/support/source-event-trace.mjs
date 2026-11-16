export function sourceEventTrace(model) {
  const records = [], attached = new WeakSet(), ids = new WeakMap();
  let sequence = 0, descriptor = 0;
  const record = value => {
    records.push({ sequence: ++sequence, ...value });
    if (records.length > 32) records.shift();
  };
  const attach = (watcher, path, current, role, root) => {
    if (!watcher || attached.has(watcher)) return;
    attached.add(watcher); ids.set(watcher, ++descriptor);
    const id = descriptor;
    record({ stage: "descriptor-observed", descriptor: id, path, role, root });
    watcher.prependListener("change", (event, filename) => record({ stage: "raw-callback", descriptor: id, path,
      role, root, event, filename: filename === undefined ? null : String(filename).slice(0, 256), owned: current() === watcher }));
    watcher.prependListener("error", error => record({ stage: "raw-error", descriptor: id, path,
      role, root, owned: current() === watcher, error: String(error).slice(0, 256) }));
    watcher.once("close", () => record({ stage: "close", descriptor: id, path }));
  };
  const attachDirectory = path => attach(model.watchers.get(path), path, () => model.watchers.get(path), "directory", path);
  const attachParent = root => {
    const entry = model.rootParents.get(root);
    attach(entry?.watcher, entry?.path, () => model.rootParents.get(root)?.watcher, "parent", root);
  };
  for (const path of model.watchers.keys()) attachDirectory(path);
  for (const root of model.rootParents.keys()) attachParent(root);
  const bind = model.watchDirectory, parent = model.watchRootParent, retire = model.unwatchDirectory;
  model.watchDirectory = function (path) { const result = bind.call(this, path); attachDirectory(path); return result; };
  model.watchRootParent = function (root) { const result = parent.call(this, root); attachParent(root); return result; };
  model.unwatchDirectory = function (path) {
    const watcher = this.watchers.get(path);
    if (watcher) record({ stage: "retire", descriptor: ids.get(watcher), path });
    return retire.call(this, path);
  };
  const hint = model.fileHint, set = model.hints.set, take = model.hints.delete;
  model.fileHint = function (directory, name) {
    record({ stage: "hint-entry", directory, name, queued: this.hints.size, pending: Boolean(this.pending) });
    const result = hint.call(this, directory, name);
    record({ stage: "hint-return", queued: this.hints.size, pending: Boolean(this.pending), repairOwed: this.repairOwed });
    return result;
  };
  model.hints.set = function (path, value) { record({ stage: "queue-admit", path }); return set.call(this, path, value); };
  model.hints.delete = function (path) { record({ stage: "queue-take", path }); return take.call(this, path); };
  const scan = model.scan, publish = model.publish;
  model.scan = function (paths) {
    record({ stage: "scan-start", paths: paths.slice(0, 4), count: paths.length });
    const result = scan.call(this, paths);
    void result.then(() => record({ stage: "scan-end", rows: this.projected.size, state: this.state }),
      error => record({ stage: "scan-error", error: String(error).slice(0, 256) }));
    return result;
  };
  model.publish = function (...args) {
    record({ stage: "publish", rows: this.projected.size, state: this.state });
    return publish.apply(this, args);
  };
  return () => ({ total: sequence, dropped: Math.max(0, sequence - records.length), records: [...records] });
}
