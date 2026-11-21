/** Private owner acknowledgement; metadata and released leases are not this barrier. */
export async function completeOwnedExit(
    exit: Promise<number | null>,
    finalize: (code: number | null) => void,
    release: () => void,
    settle: () => Promise<void>,
): Promise<void> {
    const code = await exit;
    try { finalize(code); }
    finally { release(); }
    await settle();
}
