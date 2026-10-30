import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  AzureOpenAIClient,
  createSequenceDraftClient,
  OpenAICompatibleClient,
  resolveAIProvider,
  operationByName,
  runOperation,
  type OperationContext,
  type RefineStepAction,
  type RefineStepOutput,
  type SequenceDraft,
  type SequenceDraftClient,
} from "../src/index.js";
import { AI_REQUEST_TIMEOUT_MS, AIRequestTimeoutError, IMDS_TOKEN_TIMEOUT_MS } from "../src/ai.js";

const body = `Hi {{firstName}},

Saw {{company}} is adding finance roles, which often means reporting work is growing faster than the team can absorb.

We help teams automate repetitive handoffs so analysts can spend more time on decisions.

Worth comparing notes for fifteen minutes next week?`;
const shorterBody = `Hi {{firstName}},

Saw {{company}} is adding finance roles while reporting work keeps growing.

We automate repetitive handoffs so analysts can focus on decisions.

Worth comparing notes next week?`;
const longerBody = `Hi {{firstName}},

Saw {{company}} is adding finance roles, which often means reporting work is growing faster than the team can absorb each month.

We help teams automate the repetitive handoffs, keep reviews consistent, and give analysts more time to investigate changes before reports go out.

Would it be useful to compare notes for fifteen minutes next week?`;

const draft: SequenceDraft = {
  name: "A concise outbound sequence",
  steps: [
    { delayDays: 0, subject: "A practical idea for {{company}}", body },
    { delayDays: 3, subject: "Worth comparing notes?", body },
  ],
};

const refined: RefineStepOutput = { subject: "finance reporting", body };

function aiClient(overrides: Partial<SequenceDraftClient> = {}): SequenceDraftClient {
  return {
    draftSequence: vi.fn().mockResolvedValue(draft),
    refineStep: vi.fn().mockResolvedValue(refined),
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function azureResponse(output: string) {
  return jsonResponse({ output_text: output });
}

function operation(name: string) {
  const found = operationByName.get(name);
  if (!found) throw new Error(`Missing operation ${name}`);
  return found;
}

function chatResponse(output: string) {
  return jsonResponse({ choices: [{ index: 0, message: { role: "assistant", content: output } }] });
}

function context(input: { endpoint?: string; deployment?: string; apiKey?: string; model?: string; ai?: SequenceDraftClient; db?: OperationContext["db"] } = {}): OperationContext {
  return {
    db: input.db ?? { execute: async () => ({ rows: [{ value: 1 }] }) } as unknown as OperationContext["db"],
    workspaceId: randomUUID(),
    userId: randomUUID(),
    env: {
      edition: "selfhost",
      authSecret: "ai-test-auth-secret-at-least-32-characters",
      apiBaseUrl: "https://api.example.test",
      azureOpenAIEndpoint: input.endpoint,
      azureOpenAIDeployment: input.deployment,
      aiApiKey: input.apiKey,
      aiModel: input.model,
    },
    ai: input.ai,
  };
}

function requestBody(call: Parameters<typeof fetch> | undefined): Record<string, unknown> {
  return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

// A server that never answers: the request settles only when its signal aborts.
const neverAnswers = (_url: Parameters<typeof fetch>[0], init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
  const signal = init?.signal;
  if (!signal) return;
  signal.addEventListener("abort", () => reject(signal.reason), { once: true });
});

describe("AzureOpenAIClient", () => {
  it("parses and zod-validates a valid JSON draft", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(azureResponse(JSON.stringify(draft)));
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: fetcher });

    await expect(client.draftSequence({ description: "Draft outreach for finance leaders.", stepCount: 2, tone: "direct" })).resolves.toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects a salesy, unformatted draft instead of returning it", async () => {
    const wallOfText = "Hi {{firstName}}, I hope this finds you well and wanted to reach out about a game-changing way to supercharge {{company}} outbound with our best-in-class seamless solution that unlocks synergy for your team. Can we touch base soon about this opportunity?";
    const bad = JSON.stringify({ ...draft, steps: [{ ...draft.steps[0]!, body: wallOfText }, draft.steps[1]!] });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(azureResponse(bad))
      .mockResolvedValueOnce(azureResponse(bad));
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: fetcher });

    await expect(client.draftSequence({ description: "Draft outreach.", stepCount: 2, tone: "direct" })).rejects.toThrow();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/responses"))).toHaveLength(2);
  });

  it("retries exactly once after an invalid response and then succeeds", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(azureResponse("not json"))
      .mockResolvedValueOnce(azureResponse(JSON.stringify(draft)));
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: fetcher });

    await expect(client.draftSequence({ description: "Draft outreach for finance leaders.", stepCount: 2, tone: "friendly" })).resolves.toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/responses"))).toHaveLength(2);
  });

  it("throws after two consecutive invalid responses", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(azureResponse("not json"))
      .mockResolvedValueOnce(azureResponse(JSON.stringify({ ...draft, steps: [{ ...draft.steps[0], body: "Too short {{firstName}}" }, draft.steps[1]] })));
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: fetcher });

    await expect(client.draftSequence({ description: "Draft outreach for finance leaders.", stepCount: 2, tone: "direct" })).rejects.toThrow();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/responses"))).toHaveLength(2);
  });

  it("retries a salesy, unformatted refinement and returns the valid retry", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(azureResponse(JSON.stringify({ subject: "A game-changing idea!", body: "Hi {{firstName}}, I hope this finds you well! Want to talk?" })))
      .mockResolvedValueOnce(azureResponse(JSON.stringify(refined)));
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: fetcher });

    await expect(client.refineStep({ subject: "Finance reporting", body, action: "warmer" })).resolves.toEqual(refined);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith("/responses"))).toHaveLength(2);
  });

  it("keeps the managed-identity Responses API request our cloud sends today", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "imds-token", expires_in: 3600 }))
      .mockResolvedValueOnce(azureResponse(JSON.stringify(draft)));
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1/", deployment: "codex55", fetch: fetcher });
    const input = { description: "Draft outreach for finance leaders.", stepCount: 2, tone: "direct" } as const;

    await client.draftSequence(input);

    expect(String(fetcher.mock.calls[0]?.[0])).toMatch(/^http:\/\/169\.254\.169\.254\/metadata\/identity\/oauth2\/token\?/);
    // Unchanged apart from the deadline each request now carries.
    expect(fetcher.mock.calls[0]?.[1]).toEqual({ headers: { Metadata: "true" }, signal: expect.any(AbortSignal) });
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://azure.example.test/openai/v1/responses");
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer imds-token", "content-type": "application/json" } });
    expect(Object.keys(fetcher.mock.calls[1]?.[1] ?? {})).toEqual(["method", "headers", "body", "signal"]);
    expect(fetcher.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    const sent = requestBody(fetcher.mock.calls[1]);
    expect(Object.keys(sent)).toEqual(["model", "input", "text"]);
    expect(sent).toMatchObject({
      model: "codex55",
      input: [{ role: "system" }, { role: "user", content: JSON.stringify(input) }],
      text: { format: { type: "json_schema", name: "cold_email_sequence", strict: true } },
    });
  });

  it("names Azure in its status errors and does not retry them", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(jsonResponse({ error: "busy" }, 429));
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: fetcher });

    await expect(client.draftSequence({ description: "Draft outreach.", stepCount: 2, tone: "direct" })).rejects.toThrow("Azure OpenAI response request failed with status 429.");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("gives up on a model call that never answers, with a clear error and no retry", async () => {
    expect(AI_REQUEST_TIMEOUT_MS).toBe(60_000);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockImplementationOnce(neverAnswers);
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: fetcher, timeoutMs: 20 });

    const error = await client.draftSequence({ description: "Draft outreach.", stepCount: 2, tone: "direct" }).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AIRequestTimeoutError);
    expect((error as Error).message).toBe("Azure OpenAI did not answer within 20 ms.");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("gives up on a token request that never answers, and asks again next time", async () => {
    expect(IMDS_TOKEN_TIMEOUT_MS).toBeLessThan(AI_REQUEST_TIMEOUT_MS);
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(neverAnswers)
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(azureResponse(JSON.stringify(draft)));
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: fetcher, timeoutMs: 20 });
    const input = { description: "Draft outreach for finance leaders.", stepCount: 2, tone: "direct" } as const;

    await expect(client.draftSequence(input)).rejects.toThrow("Azure managed identity did not answer within 20 ms.");
    await expect(client.draftSequence(input)).resolves.toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps a provider error that is not a timeout as it was", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockRejectedValueOnce(new TypeError("fetch failed"));
    const client = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: fetcher });

    await expect(client.draftSequence({ description: "Draft outreach.", stepCount: 2, tone: "direct" })).rejects.toThrow(TypeError);
  });
});

describe("OpenAICompatibleClient", () => {
  const input = { description: "Draft outreach for finance leaders.", stepCount: 2, tone: "direct" } as const;

  it("posts a chat completion with the same prompt and strict JSON schema, then validates the draft", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(chatResponse(JSON.stringify(draft)));
    const client = new OpenAICompatibleClient({ apiKey: "sk-test", model: "gpt-4.1-mini", fetch: fetcher });
    const azureFetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ access_token: "token", expires_in: 3600 }))
      .mockResolvedValueOnce(azureResponse(JSON.stringify(draft)));
    const azure = new AzureOpenAIClient({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", fetch: azureFetcher });

    await expect(client.draftSequence(input)).resolves.toEqual(draft);
    await azure.draftSequence(input);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer sk-test", "content-type": "application/json" } });
    const sent = requestBody(fetcher.mock.calls[0]);
    const azureSent = requestBody(azureFetcher.mock.calls[1]) as { input: unknown; text: { format: { name: string; schema: unknown } } };
    expect(sent).toEqual({
      model: "gpt-4.1-mini",
      messages: azureSent.input,
      response_format: { type: "json_schema", json_schema: { name: "cold_email_sequence", strict: true, schema: azureSent.text.format.schema } },
    });
  });

  it("uses AI_BASE_URL without a trailing slash and refines with the step's prompt", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(chatResponse(JSON.stringify(refined)));
    const client = new OpenAICompatibleClient({ apiKey: "ollama", model: "llama3.1", baseUrl: "http://ollama.local:11434/v1/", fetch: fetcher });

    await expect(client.refineStep({ subject: "Finance reporting", body, action: "warmer" })).resolves.toEqual(refined);
    expect(fetcher.mock.calls[0]?.[0]).toBe("http://ollama.local:11434/v1/chat/completions");
    expect(requestBody(fetcher.mock.calls[0])).toMatchObject({ model: "llama3.1", response_format: { json_schema: { name: "refined_email_step", strict: true } } });
  });

  it("retries once after unusable output, like the Azure path", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(chatResponse("not json"))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(draft)));
    const client = new OpenAICompatibleClient({ apiKey: "sk-test", model: "gpt-4.1-mini", fetch: fetcher });

    await expect(client.draftSequence(input)).resolves.toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("retries a wrong step count once and then gives up", async () => {
    const oneStep = JSON.stringify({ ...draft, steps: [draft.steps[0], { ...draft.steps[1]!, delayDays: 2 }, { ...draft.steps[1]!, delayDays: 3 }] });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => chatResponse(oneStep));
    const client = new OpenAICompatibleClient({ apiKey: "sk-test", model: "gpt-4.1-mini", fetch: fetcher });

    await expect(client.draftSequence(input)).rejects.toThrow("AI provider returned 3 steps instead of 2.");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails without retrying on an HTTP error, an empty reply or a refusal, and never echoes the key", async () => {
    for (const response of [
      jsonResponse({ error: { message: "Incorrect API key provided: sk-test" } }, 401),
      jsonResponse({ choices: [{ message: { role: "assistant", content: null } }] }),
      jsonResponse({ choices: [{ message: { role: "assistant", content: null, refusal: "I can't help with that." } }] }),
      jsonResponse({ unexpected: true }),
    ]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response);
      const client = new OpenAICompatibleClient({ apiKey: "sk-test", model: "gpt-4.1-mini", fetch: fetcher });
      const error = await client.draftSequence(input).then(() => undefined, (caught: unknown) => caught as Error);
      expect(error?.message).toMatch(/^AI provider (request failed with status 401|returned no text output|refused the request)\.$/);
      expect(error?.message).not.toContain("sk-test");
      expect(fetcher).toHaveBeenCalledOnce();
    }
  });

  it("accepts content returned as text parts", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ choices: [{ message: { content: [{ type: "text", text: JSON.stringify(draft) }] } }] }));
    const client = new OpenAICompatibleClient({ apiKey: "sk-test", model: "gpt-4.1-mini", fetch: fetcher });
    await expect(client.draftSequence(input)).resolves.toEqual(draft);
  });

  it("gives up on a server that never answers, with a clear error and no retry", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(neverAnswers);
    const client = new OpenAICompatibleClient({ apiKey: "sk-test", model: "gpt-4.1-mini", fetch: fetcher, timeoutMs: 20 });

    const error = await client.draftSequence(input).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(AIRequestTimeoutError);
    expect((error as Error).message).toBe("AI provider did not answer within 20 ms.");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("falls back to plain JSON mode once when the server rejects structured outputs", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Invalid parameter: 'response_format' of type 'json_schema' is not supported with this model.", param: "response_format" } }, 400))
      .mockResolvedValueOnce(chatResponse(JSON.stringify(draft)));
    const client = new OpenAICompatibleClient({ apiKey: "sk-test", model: "llama3.1", baseUrl: "http://ollama.local:11434/v1", fetch: fetcher });

    await expect(client.draftSequence(input)).resolves.toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const strict = requestBody(fetcher.mock.calls[0]) as { messages: Array<{ content: string }>; response_format: unknown };
    const plain = requestBody(fetcher.mock.calls[1]) as { model: string; messages: Array<{ role: string; content: string }>; response_format: unknown };
    expect(strict.response_format).toMatchObject({ type: "json_schema" });
    expect(plain.model).toBe("llama3.1");
    expect(plain.response_format).toEqual({ type: "json_object" });
    // Same prompt and input, with the schema the strict mode would have enforced spelled out.
    expect(plain.messages[0]?.content.startsWith(strict.messages[0]!.content)).toBe(true);
    expect(plain.messages[0]?.content).toContain('"required":["name","steps"]');
    expect(plain.messages[1]).toEqual(strict.messages[1]);
  });

  it("still validates the plain-JSON reply, retrying unusable output in that mode", async () => {
    const unsupported = () => jsonResponse({ detail: "json_schema response format is not supported" }, 400);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(unsupported())
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ subject: "A game-changing idea!", body: "Hi {{firstName}}, want to talk?" })))
      .mockResolvedValueOnce(unsupported())
      .mockResolvedValueOnce(chatResponse(JSON.stringify(refined)));
    const client = new OpenAICompatibleClient({ apiKey: "sk-test", model: "llama3.1", fetch: fetcher });

    await expect(client.refineStep({ subject: "Finance reporting", body, action: "warmer" })).resolves.toEqual(refined);
    expect(fetcher.mock.calls.map((call) => (requestBody(call).response_format as { type: string }).type)).toEqual(["json_schema", "json_object", "json_schema", "json_object"]);
  });

  it("falls back only for a 400 about response_format, and only once", async () => {
    const otherBadRequest = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ error: { message: "max_tokens is too large" } }, 400));
    await expect(new OpenAICompatibleClient({ apiKey: "sk-test", model: "m", fetch: otherBadRequest }).draftSequence(input)).rejects.toThrow("AI provider request failed with status 400.");
    expect(otherBadRequest).toHaveBeenCalledOnce();

    const serverError = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({ error: { message: "response_format backend crashed" } }, 500));
    await expect(new OpenAICompatibleClient({ apiKey: "sk-test", model: "m", fetch: serverError }).draftSequence(input)).rejects.toThrow("AI provider request failed with status 500.");
    expect(serverError).toHaveBeenCalledOnce();

    const alwaysRejects = vi.fn<typeof fetch>().mockImplementation(async () => jsonResponse({ error: { message: "Unknown field: response_format" } }, 400));
    await expect(new OpenAICompatibleClient({ apiKey: "sk-test", model: "m", fetch: alwaysRejects }).draftSequence(input)).rejects.toThrow("AI provider request failed with status 400.");
    expect(alwaysRejects).toHaveBeenCalledTimes(2);
  });
});

describe("AI provider selection", () => {
  const azure = { azureOpenAIEndpoint: "https://azure.example.test/openai/v1", azureOpenAIDeployment: "codex55" };
  const openai = { aiApiKey: "sk-test", aiModel: "gpt-4.1-mini" };

  it("prefers an API key and model, then Azure, else nothing", () => {
    expect(resolveAIProvider({ ...azure, ...openai })).toBe("openai-compatible");
    expect(resolveAIProvider(azure)).toBe("azure-openai");
    expect(resolveAIProvider({ ...azure, aiApiKey: "sk-test" })).toBe("azure-openai");
    expect(resolveAIProvider({ aiApiKey: "sk-test" })).toBeUndefined();
    expect(resolveAIProvider({ azureOpenAIEndpoint: azure.azureOpenAIEndpoint })).toBeUndefined();
    expect(createSequenceDraftClient({})).toBeUndefined();
    expect(createSequenceDraftClient({ ...azure, ...openai })).toBeInstanceOf(OpenAICompatibleClient);
    expect(createSequenceDraftClient(azure)).toBeInstanceOf(AzureOpenAIClient);
  });

  it("builds the OpenAI-compatible client against AI_BASE_URL", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(chatResponse(JSON.stringify(draft)));
    const client = createSequenceDraftClient({ ...openai, aiBaseUrl: "https://openrouter.ai/api/v1" }, { fetch: fetcher });

    await client!.draftSequence({ description: "Draft outreach for finance leaders.", stepCount: 2, tone: "direct" });
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://openrouter.ai/api/v1/chat/completions");
  });
});

describe("sequences.draft", () => {
  it("uses the injected AI client and returns its validated draft", async () => {
    const ai = aiClient();

    await expect(runOperation(operation("sequences.draft"), context({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", ai }), {
      description: "Draft outreach for finance leaders.",
      stepCount: 2,
      tone: "direct",
    })).resolves.toEqual(draft);
    expect(ai.draftSequence).toHaveBeenCalledOnce();
  });

  it.each([
    { endpoint: undefined, deployment: "codex55" },
    { endpoint: "https://azure.example.test/openai/v1", deployment: undefined },
  ])("throws ai_unconfigured when required Azure settings are absent", async ({ endpoint, deployment }) => {
    const ai = aiClient();

    await expect(runOperation(operation("sequences.draft"), context({ endpoint, deployment, ai }), {
      description: "Draft outreach for finance leaders.",
      stepCount: 2,
      tone: "direct",
    })).rejects.toMatchObject({ code: "ai_unconfigured" });
    expect(ai.draftSequence).not.toHaveBeenCalled();
  });

  it("is configured by an OpenAI-compatible key and model alone", async () => {
    const ai = aiClient();

    await expect(runOperation(operation("sequences.draft"), context({ apiKey: "sk-test", model: "gpt-4.1-mini", ai }), {
      description: "Draft outreach for finance leaders.",
      stepCount: 2,
      tone: "direct",
    })).resolves.toEqual(draft);
    expect(ai.draftSequence).toHaveBeenCalledOnce();
  });

  it("throws ai_unconfigured when only half of the OpenAI-compatible settings are present", async () => {
    const ai = aiClient();

    await expect(runOperation(operation("sequences.draft"), context({ apiKey: "sk-test", ai }), {
      description: "Draft outreach for finance leaders.",
      stepCount: 2,
      tone: "direct",
    })).rejects.toMatchObject({ code: "ai_unconfigured" });
    expect(ai.draftSequence).not.toHaveBeenCalled();
  });

  it("builds the OpenAI-compatible client from the context when none is injected, and maps its failures to UNAVAILABLE", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(chatResponse(JSON.stringify(draft)))
      .mockResolvedValueOnce(jsonResponse({ error: "down" }, 503));
    vi.stubGlobal("fetch", fetcher);
    try {
      const ctx = context({ apiKey: "sk-test", model: "gpt-4.1-mini", endpoint: "https://azure.example.test/openai/v1", deployment: "codex55" });
      const input = { description: "Draft outreach for finance leaders.", stepCount: 2, tone: "direct" };

      await expect(runOperation(operation("sequences.draft"), ctx, input)).resolves.toEqual(draft);
      expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.openai.com/v1/chat/completions");
      await expect(runOperation(operation("sequences.draft"), ctx, input)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("throws draft_quota_exceeded before calling AI when the daily quota is exhausted", async () => {
    const ai = aiClient();
    const db = { execute: vi.fn().mockResolvedValue({ rows: [] }) } as unknown as OperationContext["db"];

    await expect(runOperation(operation("sequences.draft"), context({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", ai, db }), {
      description: "Draft outreach for finance leaders.",
      stepCount: 2,
      tone: "direct",
    })).rejects.toMatchObject({ code: "draft_quota_exceeded", details: { limit: 20 } });
    expect(ai.draftSequence).not.toHaveBeenCalled();
  });
});

describe("sequences.refineStep", () => {
  const cases: Array<{ action: RefineStepAction; instruction?: string; output: RefineStepOutput }> = [
    { action: "shorten", output: { subject: "finance reporting", body: shorterBody } },
    { action: "lengthen", output: { subject: "finance reporting", body: longerBody } },
    { action: "more_direct", output: refined },
    { action: "warmer", output: refined },
    { action: "rewrite_subject", output: { subject: "a reporting question", body } },
    { action: "fix_formatting", output: refined },
    { action: "custom", instruction: "Focus the middle paragraph on analyst time.", output: refined },
  ];

  it.each(cases)("calls the client and validates the $action result", async ({ action, instruction, output }) => {
    const refineStep = vi.fn().mockResolvedValue(output);
    const ai = aiClient({ refineStep });
    const input = { subject: "Finance reporting", body, action, ...(instruction ? { instruction } : {}) };

    await expect(runOperation(operation("sequences.refineStep"), context({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", ai }), input)).resolves.toEqual(output);
    expect(refineStep).toHaveBeenCalledWith(input);
    expect(refineStep).toHaveBeenCalledOnce();
  });

  it("rejects custom refinement without an instruction before calling AI", async () => {
    const ai = aiClient();

    await expect(runOperation(operation("sequences.refineStep"), context({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", ai }), {
      subject: "Finance reporting",
      body,
      action: "custom",
    })).rejects.toThrow("An instruction is required for a custom refinement.");
    expect(ai.refineStep).not.toHaveBeenCalled();
  });

  it("rejects invalid output returned by an injected client", async () => {
    const ai = aiClient({ refineStep: vi.fn().mockResolvedValue({ subject: "A game-changing idea!", body }) });

    await expect(runOperation(operation("sequences.refineStep"), context({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", ai }), {
      subject: "Finance reporting",
      body,
      action: "warmer",
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects a shorten result that is not shorter", async () => {
    const ai = aiClient({ refineStep: vi.fn().mockResolvedValue(refined) });

    await expect(runOperation(operation("sequences.refineStep"), context({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", ai }), {
      subject: "Finance reporting",
      body,
      action: "shorten",
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("rejects a lengthen result that is not longer", async () => {
    const ai = aiClient({ refineStep: vi.fn().mockResolvedValue(refined) });

    await expect(runOperation(operation("sequences.refineStep"), context({ endpoint: "https://azure.example.test/openai/v1", deployment: "codex55", ai }), {
      subject: "Finance reporting",
      body,
      action: "lengthen",
    })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });
});
