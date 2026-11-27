// A private content store lets retained checkouts share identical Git objects and files.
// Source files are never hardlinked into storage. Restoring a file makes an independent copy.
import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    copyFileSync,
    cpSync,
    existsSync,
    lchmodSync,
    lstatSync,
    mkdirSync,
    openSync,
    readSync,
    readdirSync,
    readlinkSync,
    renameSync,
    rmSync,
    symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";

export type SavedEntry =
    | { name: string; mode: number; type: "directory" }
    | { name: string; mode: number; type: "file"; blob: string }
    | { name: string; mode: number; type: "symlink"; target: string };

function fileHash(path: string, buffer: Buffer): string {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const hash = createHash("sha256");
        let bytes: number;
        while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
        return hash.digest("hex");
    } finally {
        closeSync(fd);
    }
}

function blobPath(store: string, hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid saved file identity");
    return join(store, hash.slice(0, 2), hash.slice(2));
}

function saveFile(path: string, store: string, hash: string, buffer: Buffer): void {
    const dest = blobPath(store, hash);
    if (existsSync(dest)) return;
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    const temp = dest + "-" + randomUUID();
    try {
        copyFileSync(path, temp, constants.COPYFILE_FICLONE);
        chmodSync(temp, 0o600);
        if (fileHash(temp, buffer) !== hash) throw new Error("File changed while saving " + path);
        renameSync(temp, dest);
    } finally {
        rmSync(temp, { force: true });
    }
}

// Directories precede children. Symbolic links are captured as links, never traversed.
export function snapshotTree(root: string, store?: string, omit: ReadonlySet<string> = new Set()): SavedEntry[] {
    if (!lstatSync(root).isDirectory()) throw new Error("Expected a directory at " + root);
    const entries: SavedEntry[] = [];
    const buffer = Buffer.allocUnsafe(128 * 1024);
    function walk(parent: string): void {
        for (const child of readdirSync(join(root, parent)).sort()) {
            const name = join(parent, child);
            if (omit.has(name)) continue;
            const path = join(root, name),
                stat = lstatSync(path),
                mode = stat.mode & 0o7777;
            if (stat.isDirectory()) {
                entries.push({ name, mode, type: "directory" });
                walk(name);
            } else if (stat.isSymbolicLink()) {
                entries.push({ name, mode, type: "symlink", target: readlinkSync(path) });
            } else if (stat.isFile()) {
                const blob = fileHash(path, buffer);
                if (store) saveFile(path, store, blob, buffer);
                entries.push({ name, mode, type: "file", blob });
            } else throw new Error("Cannot save special file " + path + ". The original is retained.");
        }
    }
    walk("");
    return entries;
}

function materializeTree(
    root: string,
    entries: SavedEntry[],
    copyRegularFile: (entry: Extract<SavedEntry, { type: "file" }>, dest: string) => void,
): void {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const directories = new Set(["."]);
    for (const entry of entries) {
        const parts = entry.name.split("/");
        if (parts.some((p) => !p || p === "." || p === "..") || !directories.has(dirname(entry.name))) {
            throw new Error("Invalid path in workspace manifest");
        }
        const dest = join(root, entry.name);
        if (entry.type === "directory") {
            mkdirSync(dest);
            directories.add(entry.name);
        } else if (entry.type === "symlink") {
            symlinkSync(entry.target, dest);
            lchmodSync?.(dest, entry.mode);
        } else {
            copyRegularFile(entry, dest);
        }
    }
    for (const entry of entries.slice().reverse()) {
        if (entry.type === "directory") chmodSync(join(root, entry.name), entry.mode);
    }
}

export function restoreTree(root: string, store: string, entries: SavedEntry[]): void {
    materializeTree(root, entries, (entry, dest) => {
        copyFileSync(blobPath(store, entry.blob), dest, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
        chmodSync(dest, entry.mode);
    });
}

export function copyTree(source: string, dest: string, entries: SavedEntry[]): void {
    const rootMode = lstatSync(source).mode & 0o7777;
    materializeTree(dest, entries, (entry, target) => {
        cpSync(join(source, entry.name), target, { verbatimSymlinks: true, force: false, errorOnExist: true });
    });
    chmodSync(dest, rootMode);
}

export function verifyTree(root: string, entries: SavedEntry[], omit?: ReadonlySet<string>): void {
    if (JSON.stringify(snapshotTree(root, undefined, omit)) !== JSON.stringify(entries)) {
        throw new Error("Workspace contents changed or could not be recovered at " + root);
    }
}
