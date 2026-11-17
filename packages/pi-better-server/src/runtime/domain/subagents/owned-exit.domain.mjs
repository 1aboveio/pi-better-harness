// Generated fixed launch domain from packages/pi-better-subagents/owned-exit.ts. Do not edit directly.
/** Private owner acknowledgement; metadata and released leases are not this barrier. */
export async function completeOwnedExit(exit, finalize, release, settle) {
    const code = await exit;
    try {
        finalize(code);
    }
    finally {
        release();
    }
    await settle();
}
