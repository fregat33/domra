/** Poll `predicate` until it is truthy; throws after `timeoutMs`. */
export async function until(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  stepMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

export const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
