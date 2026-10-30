import "../../dashboard.css";
import "../../dashboard-polish.css";
import "../../dashboard-responsive.css";

import { schema } from "@inboxjoy/db";
import { Card, StatusBadge } from "@inboxjoy/ui";
import { and, asc, eq } from "drizzle-orm";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { getDb } from "@/lib/db";
import { Logo } from "@/components/logo";
import { OAuthRequestError, validateAuthorizationRequest } from "@/lib/oauth";
import { mintConsentToken } from "@/lib/oauth-consent";
import { getCurrentUser } from "@/lib/server-auth";

const SCOPE_COPY: Record<string, string> = {
  "inboxjoy:read": "Read your campaigns and sending data",
  "inboxjoy:write": "Create campaigns and send on your behalf",
};

function redirectHost(redirectUri: string): string {
  try {
    return new URL(redirectUri).host;
  } catch {
    return redirectUri;
  }
}

function registeredOn(date: Date): string {
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

function ConsentShell({ children }: { children: React.ReactNode }) {
  return <div className="app-shell oauth-consent-shell"><div className="oauth-consent-page">
    <Logo className="oauth-consent-brand" />
    {children}
  </div></div>;
}

export default async function OAuthConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const values = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "string") params.set(key, value);
  }

  let authorization;
  try {
    authorization = await validateAuthorizationRequest(params);
  } catch (error) {
    const description = error instanceof OAuthRequestError ? error.description : "This authorization request is invalid.";
    return <ConsentShell><Card className="settings-card oauth-consent-card"><p className="settings-warning" role="alert">{description}</p></Card></ConsentShell>;
  }

  const requestHeaders = await headers();
  const user = await getCurrentUser(new Request("http://inboxjoy.local/app/mcp/authorize", { headers: requestHeaders }));
  if (!user) redirect(`/app/login?next=${encodeURIComponent(`/app/mcp/authorize?${params.toString()}`)}`);

  const workspaces = await getDb().select({
    id: schema.workspaces.id,
    name: schema.workspaces.name,
    role: schema.memberships.role,
  }).from(schema.memberships).innerJoin(
    schema.workspaces,
    eq(schema.workspaces.id, schema.memberships.workspaceId),
  ).where(and(
    eq(schema.memberships.userId, user.userId),
    eq(schema.memberships.status, "active"),
  )).orderBy(asc(schema.workspaces.name));

  return <ConsentShell>
    <Card className="settings-card oauth-consent-card">
      <div className="oauth-consent-head">
        <div>
          <span className="polish-mono-label">Connected app</span>
          <h2>Authorize {authorization.clientName}</h2>
          <p>This app is requesting access to an InboxJoy workspace.</p>
          <dl className="oauth-consent-meta">
            <dt>Will send access to</dt>
            <dd><strong>{redirectHost(authorization.redirectUri)}</strong></dd>
            <dt>Registered</dt>
            <dd>{registeredOn(authorization.clientCreatedAt)}</dd>
          </dl>
        </div>
        {/* Every client self-registers (RFC 7591); none has been reviewed by InboxJoy. */}
        <StatusBadge tone="warning">Unverified app</StatusBadge>
      </div>

      <div className="oauth-consent-scopes">
        <strong>Requested permissions</strong>
        {authorization.scopes.map((scope) => <div className="oauth-consent-scope" key={scope}>
          <code>{scope}</code>
          <span>{SCOPE_COPY[scope] ?? scope}</span>
        </div>)}
      </div>

      {/* One form, two submit buttons: overlapping forms made Approve unclickable. */}
      <form action="/oauth/authorize" method="post" className="oauth-consent-form">
        <input type="hidden" name="client_id" value={authorization.clientId} />
        <input type="hidden" name="redirect_uri" value={authorization.redirectUri} />
        <input type="hidden" name="response_type" value="code" />
        <input type="hidden" name="scope" value={authorization.scope} />
        {authorization.state !== null ? <input type="hidden" name="state" value={authorization.state} /> : null}
        <input type="hidden" name="code_challenge" value={authorization.codeChallenge} />
        <input type="hidden" name="code_challenge_method" value="S256" />
        <input type="hidden" name="resource" value={authorization.resource} />
        {/* CSRF binding: one signed, 10-minute token per selectable workspace. The POST verifies
            the token for the chosen workspace against the user, client, PKCE challenge and
            redirect URI it was minted for. */}
        {workspaces.map((workspace) => <input
          type="hidden"
          name={`consent_token_${workspace.id}`}
          key={workspace.id}
          value={mintConsentToken({
            userId: user.userId,
            clientId: authorization.clientId,
            codeChallenge: authorization.codeChallenge,
            redirectUri: authorization.redirectUri,
            workspaceId: workspace.id,
          })}
        />)}

        {workspaces.length ? <label className="oauth-consent-workspace">
          Workspace
          <select name="workspace_id" defaultValue={workspaces[0]?.id} required>
            {workspaces.map((workspace) => <option value={workspace.id} key={workspace.id}>{workspace.name} ({workspace.role})</option>)}
          </select>
        </label> : <p className="settings-warning">You do not have an active workspace available for this connection.</p>}

        <div className="oauth-consent-actions">
          {workspaces.length ? <button className="ij-button ij-button--primary" name="decision" type="submit" value="approve">Approve access</button> : null}
          <button className="ij-button ij-button--ghost" name="decision" type="submit" value="deny">Deny</button>
        </div>
      </form>

      <p className="oauth-consent-footnote">You can revoke this connection anytime in Settings → MCP.</p>
    </Card>
  </ConsentShell>;
}
