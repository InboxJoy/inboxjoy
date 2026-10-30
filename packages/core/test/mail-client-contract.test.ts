import type { ComposioClient } from "@inboxjoy/composio";
import { expect, it } from "vitest";

import type { MailClient } from "../src/index.js";

it("keeps ComposioClient structurally assignable to MailClient", () => {
  const composioClient = {} as ComposioClient;
  const mailClient: MailClient = composioClient;

  expect(mailClient).toBe(composioClient);
});
