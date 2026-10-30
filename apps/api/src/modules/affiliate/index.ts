import { normalizeAffiliateCode, recordAffiliateClick } from "@inboxjoy/core";
import type { InboxJoyDb } from "@inboxjoy/db";
import type { FastifyInstance, FastifyRequest } from "fastify";

type AffiliateModuleOptions = {
  db?: InboxJoyDb;
  runOperation: (name: string, request: FastifyRequest, input: unknown) => Promise<unknown>;
};

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function registerAffiliateRoutes(app: FastifyInstance, options: AffiliateModuleOptions): void {
  app.get("/v1/affiliate", async (request) => options.runOperation("affiliate.get", request, {}));

  app.get<{ Querystring: { limit?: string } }>("/v1/affiliate/referrals", async (request) => {
    const parsedLimit = request.query.limit !== undefined ? Number(request.query.limit) : undefined;
    const limit = typeof parsedLimit === "number" && Number.isFinite(parsedLimit) ? parsedLimit : undefined;
    return options.runOperation("affiliate.listReferrals", request, { limit });
  });

  // Unauthenticated: the referral link lands here before the visitor has an
  // account, so this cannot sit behind the session/API-key preHandler. It
  // always replies 204 -- a 404 or an error would let a caller enumerate
  // which affiliate codes exist by probing this endpoint.
  app.post<{ Body: unknown }>("/v1/public/affiliate/click", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
  }, async (request, reply) => {
    const body = objectValue(request.body);
    const code = normalizeAffiliateCode(body.code);
    if (code && options.db) {
      try {
        await recordAffiliateClick(options.db, code);
      } catch (error) {
        request.log.warn({ err: error }, "failed to record affiliate click");
      }
    }
    return reply.code(204).send();
  });
}
