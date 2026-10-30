import { z } from "zod";
import { refineStepSystemPrompt } from "./prompts/refine-step.js";
import { SEQUENCE_BANNED_PHRASES, SEQUENCE_DRAFT_SYSTEM_PROMPT } from "./prompts/sequence-draft.js";
import { extractCustomVariables, isBuiltInVariable, VARIABLE_NAME_PATTERN } from "./template-variables.js";

const IMDS_TOKEN_URL = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fcognitiveservices.azure.com%2F";
const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;
// How long one model call may take, response body included, before it is
// abandoned. Drafting a full sequence is the slowest call and normally takes
// well under this. The managed-identity token comes from the local metadata
// service and gets far less.
export const AI_REQUEST_TIMEOUT_MS = 60_000;
export const IMDS_TOKEN_TIMEOUT_MS = 10_000;
export const sequenceEmailWordCount = (value: string) => value.trim().split(/\s+/).filter(Boolean).length;
const variablePattern = /\{\{\s*(firstName|company|title)\s*\}\}/;
const unsupportedVariablePattern = /\{\{\s*([^}]+?)\s*\}\}/g;

export const sequenceDraftInputSchema = z.object({
  description: z.string().trim().min(10).max(4_000),
  stepCount: z.number().int().min(2).max(8).default(4),
  tone: z.enum(["direct", "friendly"]).default("direct"),
});

const sequenceSubjectSchema = z.string().trim().min(1).max(44)
  .refine((value) => !SEQUENCE_BANNED_PHRASES.some((phrase) => value.toLowerCase().includes(phrase.toLowerCase())), "Subject used salesy filler language.")
  .refine((value) => !value.includes("!"), "Cold-email subjects must not use exclamation marks.");

const DRAFT_VARIABLES = new Set(["firstName", "company", "title"]);

// Drafting new sequences stays limited to the three built-ins. Refining an existing step
// also accepts the variables that step already uses, including per-lead custom ones.
function sequenceBodySchemaFor(allowed: (name: string) => boolean, unsupportedMessage: string) {
  return z.string().trim().refine((value) => {
    const count = sequenceEmailWordCount(value);
    return count >= 25 && count <= 90;
  }, "Email bodies must contain between 25 and 90 words.")
    .refine((value) => /^Hi \{\{firstName\}\},?\s*\n/.test(value.trim()), "Bodies must open with a greeting line of its own.")
    .refine((value) => value.split(/\n\s*\n/).filter((part) => part.trim()).length >= 3, "Bodies must be a greeting line, at least one paragraph, and the ask, separated by blank lines.")
    .refine((value) => value.trim().split(/\n\s*\n/).pop()?.trim().endsWith("?") ?? false, "The final line must be the ask, phrased as a question.")
    .refine((value) => !SEQUENCE_BANNED_PHRASES.some((phrase) => value.toLowerCase().includes(phrase.toLowerCase())), "Draft used salesy filler language.")
    .refine((value) => !value.includes("!"), "Cold-email bodies must not use exclamation marks.")
    .refine((value) => variablePattern.test(value), "Each email body must include at least one supported personalization variable.")
    .refine((value) => {
      const variables = [...value.matchAll(unsupportedVariablePattern)].map((match) => match[1]?.trim() ?? "");
      return variables.every(allowed);
    }, unsupportedMessage);
}

const sequenceBodySchema = sequenceBodySchemaFor((name) => DRAFT_VARIABLES.has(name), "Only {{firstName}}, {{company}}, and {{title}} personalization variables are supported.");

export const sequenceEmailContentSchema = z.object({
  subject: sequenceSubjectSchema,
  body: sequenceBodySchema,
}).strict();

// Refined output may carry custom per-lead variables; validateRefinedStep narrows them to
// the ones the input step already used.
export const refineStepOutputSchema = z.object({
  subject: sequenceSubjectSchema,
  body: sequenceBodySchemaFor((name) => DRAFT_VARIABLES.has(name) || (VARIABLE_NAME_PATTERN.test(name) && !isBuiltInVariable(name)), "Only {{firstName}}, {{company}}, {{title}}, and custom {{name}} personalization variables are supported."),
}).strict();

const sequenceDraftStepSchema = sequenceEmailContentSchema.extend({
  delayDays: z.number().int().min(0).max(4),
}).strict();

export const refineStepActionSchema = z.enum(["shorten", "lengthen", "more_direct", "warmer", "rewrite_subject", "fix_formatting", "custom"]);
export const refineStepInputSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(20_000, "Email body is too long."),
  action: refineStepActionSchema,
  instruction: z.string().trim().max(500, "Custom instructions must be 500 characters or fewer.").optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "custom" && !value.instruction) {
    context.addIssue({ code: "custom", path: ["instruction"], message: "An instruction is required for a custom refinement." });
  }
});


export const sequenceDraftOutputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  steps: z.array(sequenceDraftStepSchema).min(2).max(8),
}).strict().superRefine((value, context) => {
  if (value.steps[0]?.delayDays !== 0) {
    context.addIssue({ code: "custom", path: ["steps", 0, "delayDays"], message: "The first step must have delayDays 0." });
  }
  value.steps.slice(1).forEach((step, index) => {
    if (step.delayDays < 2 || step.delayDays > 4) {
      context.addIssue({ code: "custom", path: ["steps", index + 1, "delayDays"], message: "Follow-up steps must use a 2-4 day gap." });
    }
  });
});

export type SequenceDraftInput = z.infer<typeof sequenceDraftInputSchema>;
export type SequenceDraft = z.infer<typeof sequenceDraftOutputSchema>;
export type RefineStepAction = z.infer<typeof refineStepActionSchema>;
export type RefineStepInput = z.infer<typeof refineStepInputSchema>;
export type RefineStepOutput = z.infer<typeof refineStepOutputSchema>;

export type SequenceDraftClient = {
  draftSequence: (input: SequenceDraftInput) => Promise<SequenceDraft>;
  refineStep: (input: RefineStepInput) => Promise<RefineStepOutput>;
};

type Fetch = typeof fetch;

// A model call (or the token request before it) that ran past its deadline.
// Not retried: a provider that stalled once usually stalls again, and the
// person is already waiting.
export class AIRequestTimeoutError extends Error {
  constructor(provider: string, timeoutMs: number) {
    super(`${provider} did not answer within ${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${timeoutMs} ms`}.`);
    this.name = "AIRequestTimeoutError";
  }
}

// Runs one HTTP exchange under its own deadline. The signal also bounds
// reading the body, so a server that sends headers and then stalls is cut off
// too. Only an abort from this deadline becomes AIRequestTimeoutError.
async function withDeadline<T>(provider: string, timeoutMs: number, exchange: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await exchange(signal);
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? error.name : undefined;
    if (signal.aborted && (name === "TimeoutError" || name === "AbortError")) throw new AIRequestTimeoutError(provider, timeoutMs);
    throw error;
  }
}

type AzureOpenAIOptions = {
  endpoint: string;
  deployment: string;
  fetch?: Fetch;
  now?: () => number;
  // Per model call; defaults to AI_REQUEST_TIMEOUT_MS.
  timeoutMs?: number;
};

export const DEFAULT_AI_BASE_URL = "https://api.openai.com/v1";

type OpenAICompatibleOptions = {
  apiKey: string;
  model: string;
  // Any OpenAI-compatible API root (OpenAI, OpenRouter, a local Ollama /v1).
  baseUrl?: string;
  fetch?: Fetch;
  // Per model call; defaults to AI_REQUEST_TIMEOUT_MS.
  timeoutMs?: number;
};

// A 400 whose body names these is a server without structured outputs (many
// OpenAI-compatible servers take only {"type":"json_object"}).
const STRUCTURED_OUTPUT_UNSUPPORTED_PATTERN = /response_format|json_schema/i;

class StructuredOutputUnsupportedError extends Error {}

type CachedToken = { value: string; expiresAt: number };

// One structured-output call: a system prompt, the user JSON, and the schema the
// reply must follow. Each provider turns it into its own request shape.
type StructuredRequest = {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
};

const sequenceDraftResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "steps"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 120 },
    steps: {
      type: "array",
      minItems: 2,
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["delayDays", "subject", "body"],
        properties: {
          delayDays: { type: "integer", minimum: 0, maximum: 4 },
          subject: { type: "string", minLength: 1, maxLength: 44 },
          body: { type: "string", minLength: 1 },
        },
      },
    },
  },
} as const;

const refineStepResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: {
    subject: { type: "string", minLength: 1, maxLength: 44 },
    body: { type: "string", minLength: 1 },
  },
} as const;

export function validateRefinedStep(input: RefineStepInput, output: unknown): RefineStepOutput {
  const refined = refineStepOutputSchema.parse(output);
  const usedBefore = new Set([...extractCustomVariables(input.subject, input.body), ...DRAFT_VARIABLES]);
  const introduced = extractCustomVariables(refined.subject, refined.body).filter((name) => !usedBefore.has(name));
  if (introduced.length) throw new Error(`Refinement introduced variables the step did not use: ${introduced.map((name) => `{{${name}}}`).join(", ")}.`);
  const before = sequenceEmailWordCount(input.body);
  const after = sequenceEmailWordCount(refined.body);
  if (input.action === "shorten" && after >= before) throw new Error("The shortened email must contain fewer words than the original.");
  if (input.action === "lengthen" && after <= before) throw new Error("The lengthened email must contain more words than the original.");
  return refined;
}

function parseExpiry(payload: Record<string, unknown>, now: number): number {
  const expiresOn = payload.expires_on;
  if (typeof expiresOn === "number" && Number.isFinite(expiresOn)) return expiresOn * 1000;
  if (typeof expiresOn === "string") {
    const epochSeconds = Number(expiresOn);
    if (Number.isFinite(epochSeconds)) return epochSeconds * 1000;
    const parsed = Date.parse(expiresOn);
    if (Number.isFinite(parsed)) return parsed;
  }
  const expiresIn = Number(payload.expires_in);
  return now + (Number.isFinite(expiresIn) ? expiresIn * 1000 : 60 * 60 * 1000);
}

function responseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("Azure OpenAI returned an invalid response.");
  const value = payload as { output_text?: unknown; output?: unknown };
  if (typeof value.output_text === "string" && value.output_text.trim()) return value.output_text;
  if (Array.isArray(value.output)) {
    for (const item of value.output) {
      if (!item || typeof item !== "object") continue;
      const content = (item as { content?: unknown }).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
      }
    }
  }
  throw new Error("Azure OpenAI returned no text output.");
}

function chatCompletionText(payload: unknown): string {
  if (!payload || typeof payload !== "object") throw new Error("AI provider returned an invalid response.");
  const choices = (payload as { choices?: unknown }).choices;
  const message = Array.isArray(choices) && choices[0] && typeof choices[0] === "object"
    ? (choices[0] as { message?: unknown }).message
    : undefined;
  if (message && typeof message === "object") {
    const { content, refusal } = message as { content?: unknown; refusal?: unknown };
    if (typeof content === "string" && content.trim()) return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
      }
    }
    if (typeof refusal === "string" && refusal.trim()) throw new Error("AI provider refused the request.");
  }
  throw new Error("AI provider returned no text output.");
}

/**
 * Drafting and refinement on top of one structured-output call. Prompts, JSON
 * parsing, zod validation and the single retry on unusable output are shared,
 * so every provider behaves the same; only the HTTP request differs.
 */
abstract class StructuredSequenceDraftClient implements SequenceDraftClient {
  protected constructor(private readonly providerLabel: string) {}

  protected abstract completeJson(request: StructuredRequest): Promise<string>;

  private async requestDraft(input: SequenceDraftInput): Promise<SequenceDraft> {
    const parsed = JSON.parse(await this.completeJson({
      system: SEQUENCE_DRAFT_SYSTEM_PROMPT,
      user: JSON.stringify(input),
      schemaName: "cold_email_sequence",
      schema: sequenceDraftResponseJsonSchema,
    }));
    const draft = sequenceDraftOutputSchema.parse(parsed);
    if (draft.steps.length !== input.stepCount) throw new Error(`${this.providerLabel} returned ${draft.steps.length} steps instead of ${input.stepCount}.`);
    return draft;
  }

  async draftSequence(input: SequenceDraftInput): Promise<SequenceDraft> {
    let parseError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.requestDraft(input);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof z.ZodError || (error instanceof Error && error.message.includes("steps instead")))) throw error;
        parseError = error;
      }
    }
    throw parseError;
  }

  private async requestRefinement(input: RefineStepInput): Promise<RefineStepOutput> {
    return validateRefinedStep(input, JSON.parse(await this.completeJson({
      system: refineStepSystemPrompt(input.action),
      user: JSON.stringify(input),
      schemaName: "refined_email_step",
      schema: refineStepResponseJsonSchema,
    })));
  }

  async refineStep(input: RefineStepInput): Promise<RefineStepOutput> {
    let validationError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.requestRefinement(input);
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof z.ZodError || (error instanceof Error && /must contain (fewer|more) words/.test(error.message)))) throw error;
        validationError = error;
      }
    }
    throw validationError;
  }
}

// Our cloud: Azure OpenAI's Responses API with a managed-identity token from IMDS.
export class AzureOpenAIClient extends StructuredSequenceDraftClient {
  private readonly endpoint: string;
  private readonly deployment: string;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private token?: CachedToken;
  private tokenRequest?: Promise<CachedToken>;

  constructor(options: AzureOpenAIOptions) {
    super("Azure OpenAI");
    this.endpoint = options.endpoint.replace(/\/$/, "");
    this.deployment = options.deployment;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt - TOKEN_REFRESH_WINDOW_MS > this.now()) return this.token.value;
    if (!this.tokenRequest) {
      this.tokenRequest = withDeadline("Azure managed identity", Math.min(IMDS_TOKEN_TIMEOUT_MS, this.timeoutMs), async (signal) => {
        const response = await this.fetcher(IMDS_TOKEN_URL, { headers: { Metadata: "true" }, signal });
        if (!response.ok) throw new Error(`Azure IMDS token request failed with status ${response.status}.`);
        const payload = await response.json() as Record<string, unknown>;
        if (typeof payload.access_token !== "string" || !payload.access_token) throw new Error("Azure IMDS returned no access token.");
        return { value: payload.access_token, expiresAt: parseExpiry(payload, this.now()) };
      }).finally(() => { this.tokenRequest = undefined; });
    }
    this.token = await this.tokenRequest;
    return this.token.value;
  }

  protected async completeJson(request: StructuredRequest): Promise<string> {
    const token = await this.accessToken();
    return withDeadline("Azure OpenAI", this.timeoutMs, async (signal) => {
      const response = await this.fetcher(`${this.endpoint}/responses`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.deployment,
          input: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          text: { format: { type: "json_schema", name: request.schemaName, strict: true, schema: request.schema } },
        }),
        signal,
      });
      if (!response.ok) throw new Error(`Azure OpenAI response request failed with status ${response.status}.`);
      return responseText(await response.json());
    });
  }
}

// Self-hosted installs: any OpenAI-compatible Chat Completions endpoint with an API key.
export class OpenAICompatibleClient extends StructuredSequenceDraftClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly fetcher: Fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAICompatibleOptions) {
    super("AI provider");
    this.baseUrl = (options.baseUrl ?? DEFAULT_AI_BASE_URL).replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.fetcher = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? AI_REQUEST_TIMEOUT_MS;
  }

  // Strict structured output first. A server that rejects response_format or
  // json_schema with a 400 gets the request once more in plain JSON mode, with
  // the schema spelled out in the system prompt; the shared parsing and zod
  // validation still decide whether the reply is usable.
  protected async completeJson(request: StructuredRequest): Promise<string> {
    try {
      return await this.chatCompletion(request, "json_schema");
    } catch (error) {
      if (!(error instanceof StructuredOutputUnsupportedError)) throw error;
      return this.chatCompletion(request, "json_object");
    }
  }

  private chatCompletion(request: StructuredRequest, mode: "json_schema" | "json_object"): Promise<string> {
    const system = mode === "json_schema"
      ? request.system
      : `${request.system}\n\nReply with one JSON object that follows this JSON schema:\n${JSON.stringify(request.schema)}`;
    return withDeadline("AI provider", this.timeoutMs, async (signal) => {
      const response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: system },
            { role: "user", content: request.user },
          ],
          response_format: mode === "json_schema"
            ? { type: "json_schema", json_schema: { name: request.schemaName, strict: true, schema: request.schema } }
            : { type: "json_object" },
        }),
        signal,
      });
      if (mode === "json_schema" && response.status === 400 && STRUCTURED_OUTPUT_UNSUPPORTED_PATTERN.test(await response.text())) {
        throw new StructuredOutputUnsupportedError("The AI provider does not support structured outputs.");
      }
      if (!response.ok) throw new Error(`AI provider request failed with status ${response.status}.`);
      return chatCompletionText(await response.json());
    });
  }
}

export function createAzureOpenAIClient(options: AzureOpenAIOptions): SequenceDraftClient {
  return new AzureOpenAIClient(options);
}

export function createOpenAICompatibleClient(options: OpenAICompatibleOptions): SequenceDraftClient {
  return new OpenAICompatibleClient(options);
}

// The AI settings an operation reads from OperationContext.env.
export type AIProviderSettings = {
  azureOpenAIEndpoint?: string;
  azureOpenAIDeployment?: string;
  aiApiKey?: string;
  aiModel?: string;
  aiBaseUrl?: string;
};

export type AIProvider = "openai-compatible" | "azure-openai";

/**
 * AI_API_KEY + AI_MODEL (any OpenAI-compatible endpoint) win; otherwise Azure
 * OpenAI with managed identity when its endpoint and deployment are set (our
 * cloud); otherwise AI drafting is off.
 */
export function resolveAIProvider(settings: AIProviderSettings): AIProvider | undefined {
  if (settings.aiApiKey && settings.aiModel) return "openai-compatible";
  if (settings.azureOpenAIEndpoint && settings.azureOpenAIDeployment) return "azure-openai";
  return undefined;
}

export function createSequenceDraftClient(settings: AIProviderSettings, dependencies: { fetch?: Fetch } = {}): SequenceDraftClient | undefined {
  if (settings.aiApiKey && settings.aiModel) {
    return createOpenAICompatibleClient({ apiKey: settings.aiApiKey, model: settings.aiModel, baseUrl: settings.aiBaseUrl, fetch: dependencies.fetch });
  }
  if (settings.azureOpenAIEndpoint && settings.azureOpenAIDeployment) {
    return createAzureOpenAIClient({ endpoint: settings.azureOpenAIEndpoint, deployment: settings.azureOpenAIDeployment, fetch: dependencies.fetch });
  }
  return undefined;
}
