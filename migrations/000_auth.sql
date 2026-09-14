-- Better Auth 1.7.4: core, JWT, MCP OAuth provider, CIMD, persistent rate limits.
-- Derived from getSchema(authOptions()); JSON arrays use jsonb per Better Auth's pg adapter.

CREATE TABLE "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL,
  "image" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE "session" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id" text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE "jwks" (
  "id" text PRIMARY KEY,
  "publicKey" text NOT NULL,
  "privateKey" text NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "expiresAt" timestamptz,
  "alg" text,
  "crv" text
);

CREATE TABLE "oauthClient" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL UNIQUE,
  "clientSecret" text,
  "clientDiscoveryId" text,
  "disabled" boolean,
  "skipConsent" boolean,
  "enableEndSession" boolean,
  "subjectType" text,
  "scopes" jsonb,
  "clientCredentialsScopes" jsonb,
  "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "name" text,
  "uri" text,
  "icon" text,
  "contacts" jsonb,
  "tos" text,
  "policy" text,
  "softwareId" text,
  "softwareVersion" text,
  "softwareStatement" text,
  "redirectUris" jsonb NOT NULL,
  "postLogoutRedirectUris" jsonb,
  "backchannelLogoutUri" text,
  "backchannelLogoutSessionRequired" boolean,
  "tokenEndpointAuthMethod" text,
  "applicationType" text,
  "jwks" text,
  "jwksUri" text,
  "grantTypes" jsonb,
  "responseTypes" jsonb,
  "requirePKCE" boolean,
  "dpopBoundAccessTokens" boolean,
  "referenceId" text,
  "metadata" jsonb
);

CREATE TABLE "oauthResource" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "accessTokenTtl" integer,
  "refreshTokenTtl" integer,
  "signingAlgorithm" text,
  "signingKeyId" text,
  "allowedScopes" jsonb,
  "customClaims" jsonb,
  "dpopBoundAccessTokensRequired" boolean,
  "disabled" boolean,
  "createdAt" timestamptz,
  "updatedAt" timestamptz,
  "policyVersion" integer,
  "metadata" jsonb
);

CREATE TABLE "oauthClientResource" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "resourceId" text NOT NULL REFERENCES "oauthResource"("identifier") ON DELETE CASCADE,
  "metadata" jsonb,
  "createdAt" timestamptz
);

CREATE TABLE "oauthRefreshToken" (
  "id" text PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES "session"("id") ON DELETE SET NULL,
  "userId" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "revoked" timestamptz,
  "rotatedAt" timestamptz,
  "rotationReplayResponse" text,
  "rotationReplayExpiresAt" timestamptz,
  "authTime" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb NOT NULL
);

CREATE TABLE "oauthAccessToken" (
  "id" text PRIMARY KEY,
  "token" text NOT NULL UNIQUE,
  "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "sessionId" text REFERENCES "session"("id") ON DELETE SET NULL,
  "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
  "referenceId" text,
  "authorizationCodeId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "refreshId" text REFERENCES "oauthRefreshToken"("id") ON DELETE CASCADE,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "revoked" timestamptz,
  "confirmation" jsonb,
  "scopes" jsonb NOT NULL
);

CREATE TABLE "oauthConsent" (
  "id" text PRIMARY KEY,
  "clientId" text NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
  "userId" text REFERENCES "user"("id") ON DELETE CASCADE,
  "referenceId" text,
  "resources" jsonb,
  "requestedUserInfoClaims" jsonb,
  "scopes" jsonb NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);

CREATE TABLE "oauthClientAssertion" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL
);

CREATE TABLE "rateLimit" (
  "id" text PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL,
  "lastRequest" bigint NOT NULL
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");
CREATE INDEX "oauthClient_userId_idx" ON "oauthClient" ("userId");
CREATE INDEX "oauthClientResource_clientId_idx" ON "oauthClientResource" ("clientId");
CREATE INDEX "oauthClientResource_resourceId_idx" ON "oauthClientResource" ("resourceId");
CREATE UNIQUE INDEX "oauthClientResource_clientId_resourceId_uidx" ON "oauthClientResource" ("clientId", "resourceId");
CREATE INDEX "oauthRefreshToken_clientId_idx" ON "oauthRefreshToken" ("clientId");
CREATE INDEX "oauthRefreshToken_sessionId_idx" ON "oauthRefreshToken" ("sessionId");
CREATE INDEX "oauthRefreshToken_userId_idx" ON "oauthRefreshToken" ("userId");
CREATE INDEX "oauthRefreshToken_authorizationCodeId_idx" ON "oauthRefreshToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_clientId_idx" ON "oauthAccessToken" ("clientId");
CREATE INDEX "oauthAccessToken_sessionId_idx" ON "oauthAccessToken" ("sessionId");
CREATE INDEX "oauthAccessToken_userId_idx" ON "oauthAccessToken" ("userId");
CREATE INDEX "oauthAccessToken_authorizationCodeId_idx" ON "oauthAccessToken" ("authorizationCodeId");
CREATE INDEX "oauthAccessToken_refreshId_idx" ON "oauthAccessToken" ("refreshId");
CREATE INDEX "oauthConsent_clientId_idx" ON "oauthConsent" ("clientId");
CREATE INDEX "oauthConsent_userId_idx" ON "oauthConsent" ("userId");
