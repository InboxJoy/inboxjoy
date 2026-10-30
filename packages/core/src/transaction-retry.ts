export async function retryTransaction<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      let cause: unknown = error;
      let retryable = false;
      while (cause && typeof cause === "object") {
        if ("code" in cause && (cause.code === "40P01" || cause.code === "40001")) {
          retryable = true;
          break;
        }
        cause = "cause" in cause ? cause.cause : null;
      }
      if (!retryable || attempt >= 4) throw error;
    }
  }
}
