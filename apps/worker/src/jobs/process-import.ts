import type { ProcessImportJob } from "@inboxjoy/queue";

export async function processImport(payload: ProcessImportJob): Promise<void> {
  throw new Error(`Import processing is not implemented; refusing to mark import ${payload.importId} complete.`);
}
