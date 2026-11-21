/** Preserve the first body failure when teardown also fails, without hiding teardown-only failures. */
export async function withFixtureCleanup(body: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
  let bodyFailed = false, bodyError: unknown;
  try { await body(); }
  catch (error) { bodyFailed = true; bodyError = error; }
  try { await cleanup(); }
  catch (cleanupError) {
    const describe = (error: unknown) => {
      const value = error as { name?: unknown; message?: unknown; code?: unknown; syscall?: unknown } | null;
      const text = (field: unknown) => typeof field === 'string' ? field.slice(0, 1024) : null;
      return { name: text(value?.name), message: text(value?.message), code: text(value?.code), syscall: text(value?.syscall) };
    };
    console.error('[result-supervision-fixture-failure]', JSON.stringify({
      bodyCompleted: !bodyFailed, firstBodyError: bodyFailed ? describe(bodyError) : null, cleanupError: describe(cleanupError),
    }));
    if (!bodyFailed) throw cleanupError;
  }
  if (bodyFailed) throw bodyError;
}
