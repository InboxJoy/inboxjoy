import { describe, expect, it } from "vitest";

import { renderPersonalized } from "../src/index.js";
import { csvCell } from "../src/sending-analytics.js";

describe("security hardening", () => {
  it("guards CSV cells that spreadsheet apps could interpret as formulas", () => {
    expect(csvCell("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvCell("Acme Inc")).toBe("Acme Inc");
  });

  it("strips CRLF characters from merge-tag values", () => {
    expect(renderPersonalized("Hello {{firstName}} at {{company}}", {
      firstName: "Ada\r\nBcc: attacker@example.com",
      lastName: "Lovelace",
      company: "Analytical\nEngine",
      title: "Founder",
      email: "ada@example.com",
    })).toBe("Hello AdaBcc: attacker@example.com at AnalyticalEngine");
  });
});
