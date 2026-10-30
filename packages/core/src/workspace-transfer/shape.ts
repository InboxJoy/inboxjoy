import { WORKSPACE_TRANSFER_LIMITS, WorkspaceTransferError } from "./format.js";

// A structural check on the raw upload, run while the body streams in and
// before JSON.parse. JSON.parse turns a few bytes like `{},` into a whole
// object, so 50 MB of `[{},{},...]` would cost the API gigabytes of heap; the
// count and depth caps stop such a body after a few MB, with a 400.

const L = WORKSPACE_TRANSFER_LIMITS;

export const WORKSPACE_TRANSFER_SHAPE = {
  // The deepest a valid file goes is 6 (file > sequences > sequence >
  // leadVariables > row > values); the rest is headroom for later fields.
  maxDepth: 10,
  // Every object and array a file at its limits can hold, plus headroom.
  maxContainers: 64
    + L.leads * 2 // each lead and its customFields
    + L.lists * 2 // each list and its leadEmails
    + L.suppressions
    + L.sequences * (4 + L.stepsPerSequence + L.campaignsPerSequence * 2) // sequence, steps, campaigns, leadVariables, each step, each campaign and its listNames
    + L.leadVariableRows * 2 // each row and its values
    + L.mailboxes * (2 + 7) // mailbox, sendingWindows and up to seven windows
    + L.team,
} as const;

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;

// Returns a function to feed the body to, chunk by chunk; it throws a
// WorkspaceTransferError as soon as a cap is passed. Bytes are scanned
// directly: UTF-8 never uses ASCII values inside a multi-byte character, so a
// character split across chunks cannot look like a bracket or a quote.
// Malformed JSON is left for JSON.parse to reject.
export function createWorkspaceFileShapeCheck(shape: { maxDepth: number; maxContainers: number } = WORKSPACE_TRANSFER_SHAPE): (chunk: Uint8Array) => void {
  let depth = 0;
  let containers = 0;
  let inString = false;
  let escaped = false;
  return (chunk) => {
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (byte === BACKSLASH) escaped = true;
        else if (byte === QUOTE) inString = false;
        continue;
      }
      if (byte === QUOTE) {
        inString = true;
      } else if (byte === OPEN_OBJECT || byte === OPEN_ARRAY) {
        depth++;
        containers++;
        if (depth > shape.maxDepth) {
          throw new WorkspaceTransferError("invalid_export", "This file is nested deeper than an InboxJoy workspace export can be.", { maxDepth: shape.maxDepth });
        }
        if (containers > shape.maxContainers) {
          throw new WorkspaceTransferError("import_too_large", "This file has more entries than one import can hold.", { field: "entries", limit: shape.maxContainers });
        }
      } else if ((byte === CLOSE_OBJECT || byte === CLOSE_ARRAY) && depth > 0) {
        depth--;
      }
    }
  };
}
