import type { ApiScope } from "./contracts.ts";

export type { ApiScope } from "./contracts.ts";

export interface ApiToken {
  token: string;
  scopes: ApiScope[];
  principal: string;
  apiKeyId?: string;
  organizationId?: string;
  projectId?: string;
}

export function parseApiTokens(env: Record<string, string | undefined> = process.env): ApiToken[] {
  const tokens: ApiToken[] = [];
  if (env.WASMPLANE_API_TOKEN && env.WASMPLANE_API_TOKEN.trim().length > 0) {
    tokens.push({
      token: env.WASMPLANE_API_TOKEN.trim(),
      scopes: ["*"],
      principal: "legacy",
    });
  }
  const scoped = env.WASMPLANE_API_TOKENS;
  if (scoped) {
    for (const entry of scoped.split(";")) {
      const [token, scopesText] = entry.split("=");
      if (!token || !scopesText) {
        continue;
      }
      const scopes = scopesText
        .split(",")
        .map((scope) => scope.trim())
        .filter((scope): scope is ApiScope => isApiScope(scope));
      if (token.trim().length > 0 && scopes.length > 0) {
        tokens.push({
          token: token.trim(),
          scopes,
          principal: `token:${token.trim()}`,
        });
      }
    }
  }
  return tokens;
}

export function tokenAllows(token: ApiToken, requiredScope: ApiScope): boolean {
  return token.scopes.includes("*") || token.scopes.includes(requiredScope);
}

function isApiScope(value: string): value is ApiScope {
  return value === "*" || value === "read" || value === "write" || value === "publish";
}
