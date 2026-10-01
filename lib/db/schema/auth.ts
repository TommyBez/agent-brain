import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const user = pgTable(
  "user",
  {
    id: text().primaryKey().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull(),
    image: text(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [unique("user_email_key").on(table.email)],
);

export const session = pgTable(
  "session",
  {
    id: text().primaryKey().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    token: text().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: text().notNull(),
  },
  (table) => [
    index("session_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "session_userId_fkey",
    }).onDelete("cascade"),
    unique("session_token_key").on(table.token),
  ],
);

export const account = pgTable(
  "account",
  {
    id: text().primaryKey().notNull(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: text().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true, mode: "string" }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: "string" }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("account_userId_idx").using("btree", table.userId.asc().nullsLast()),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "account_userId_fkey",
    }).onDelete("cascade"),
  ],
);

export const verification = pgTable(
  "verification",
  {
    id: text().primaryKey().notNull(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("verification_identifier_idx").using(
      "btree",
      table.identifier.asc().nullsLast(),
    ),
  ],
);

export const jwks = pgTable("jwks", {
  id: text().primaryKey().notNull(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  expiresAt: timestamp({ withTimezone: true, mode: "string" }),
  alg: text(),
  crv: text(),
});

export const oauthClient = pgTable(
  "oauthClient",
  {
    id: text().primaryKey().notNull(),
    clientId: text().notNull(),
    clientSecret: text(),
    clientDiscoveryId: text(),
    disabled: boolean(),
    skipConsent: boolean(),
    enableEndSession: boolean(),
    subjectType: text(),
    scopes: jsonb(),
    clientCredentialsScopes: jsonb(),
    userId: text(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }),
    name: text(),
    uri: text(),
    icon: text(),
    contacts: jsonb(),
    tos: text(),
    policy: text(),
    softwareId: text(),
    softwareVersion: text(),
    softwareStatement: text(),
    redirectUris: jsonb().notNull(),
    postLogoutRedirectUris: jsonb(),
    backchannelLogoutUri: text(),
    backchannelLogoutSessionRequired: boolean(),
    tokenEndpointAuthMethod: text(),
    applicationType: text(),
    jwks: text(),
    jwksUri: text(),
    grantTypes: jsonb(),
    responseTypes: jsonb(),
    requirePkce: boolean("requirePKCE"),
    dpopBoundAccessTokens: boolean(),
    referenceId: text(),
    metadata: jsonb(),
  },
  (table) => [
    index("oauthClient_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "oauthClient_userId_fkey",
    }).onDelete("cascade"),
    unique("oauthClient_clientId_key").on(table.clientId),
  ],
);

export const oauthClientResource = pgTable(
  "oauthClientResource",
  {
    id: text().primaryKey().notNull(),
    clientId: text().notNull(),
    resourceId: text().notNull(),
    metadata: jsonb(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }),
  },
  (table) => [
    index("oauthClientResource_clientId_idx").using(
      "btree",
      table.clientId.asc().nullsLast(),
    ),
    uniqueIndex("oauthClientResource_clientId_resourceId_uidx").using(
      "btree",
      table.clientId.asc().nullsLast(),
      table.resourceId.asc().nullsLast(),
    ),
    index("oauthClientResource_resourceId_idx").using(
      "btree",
      table.resourceId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthClientResource_clientId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.resourceId],
      foreignColumns: [oauthResource.identifier],
      name: "oauthClientResource_resourceId_fkey",
    }).onDelete("cascade"),
  ],
);

export const oauthResource = pgTable(
  "oauthResource",
  {
    id: text().primaryKey().notNull(),
    identifier: text().notNull(),
    name: text().notNull(),
    accessTokenTtl: integer(),
    refreshTokenTtl: integer(),
    signingAlgorithm: text(),
    signingKeyId: text(),
    allowedScopes: jsonb(),
    customClaims: jsonb(),
    dpopBoundAccessTokensRequired: boolean(),
    disabled: boolean(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }),
    policyVersion: integer(),
    metadata: jsonb(),
  },
  (table) => [unique("oauthResource_identifier_key").on(table.identifier)],
);

export const oauthRefreshToken = pgTable(
  "oauthRefreshToken",
  {
    id: text().primaryKey().notNull(),
    token: text().notNull(),
    clientId: text().notNull(),
    sessionId: text(),
    userId: text().notNull(),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: jsonb(),
    requestedUserInfoClaims: jsonb(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    revoked: timestamp({ withTimezone: true, mode: "string" }),
    rotatedAt: timestamp({ withTimezone: true, mode: "string" }),
    rotationReplayResponse: text(),
    rotationReplayExpiresAt: timestamp({ withTimezone: true, mode: "string" }),
    authTime: timestamp({ withTimezone: true, mode: "string" }),
    confirmation: jsonb(),
    scopes: jsonb().notNull(),
  },
  (table) => [
    index("oauthRefreshToken_authorizationCodeId_idx").using(
      "btree",
      table.authorizationCodeId.asc().nullsLast(),
    ),
    index("oauthRefreshToken_clientId_idx").using(
      "btree",
      table.clientId.asc().nullsLast(),
    ),
    index("oauthRefreshToken_sessionId_idx").using(
      "btree",
      table.sessionId.asc().nullsLast(),
    ),
    index("oauthRefreshToken_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthRefreshToken_clientId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [session.id],
      name: "oauthRefreshToken_sessionId_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "oauthRefreshToken_userId_fkey",
    }).onDelete("cascade"),
    unique("oauthRefreshToken_token_key").on(table.token),
  ],
);

export const oauthAccessToken = pgTable(
  "oauthAccessToken",
  {
    id: text().primaryKey().notNull(),
    token: text().notNull(),
    clientId: text().notNull(),
    sessionId: text(),
    userId: text(),
    referenceId: text(),
    authorizationCodeId: text(),
    resources: jsonb(),
    requestedUserInfoClaims: jsonb(),
    refreshId: text(),
    expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    revoked: timestamp({ withTimezone: true, mode: "string" }),
    confirmation: jsonb(),
    scopes: jsonb().notNull(),
  },
  (table) => [
    index("oauthAccessToken_authorizationCodeId_idx").using(
      "btree",
      table.authorizationCodeId.asc().nullsLast(),
    ),
    index("oauthAccessToken_clientId_idx").using(
      "btree",
      table.clientId.asc().nullsLast(),
    ),
    index("oauthAccessToken_refreshId_idx").using(
      "btree",
      table.refreshId.asc().nullsLast(),
    ),
    index("oauthAccessToken_sessionId_idx").using(
      "btree",
      table.sessionId.asc().nullsLast(),
    ),
    index("oauthAccessToken_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthAccessToken_clientId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId],
      foreignColumns: [session.id],
      name: "oauthAccessToken_sessionId_fkey",
    }).onDelete("set null"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "oauthAccessToken_userId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.refreshId],
      foreignColumns: [oauthRefreshToken.id],
      name: "oauthAccessToken_refreshId_fkey",
    }).onDelete("cascade"),
    unique("oauthAccessToken_token_key").on(table.token),
  ],
);

export const oauthConsent = pgTable(
  "oauthConsent",
  {
    id: text().primaryKey().notNull(),
    clientId: text().notNull(),
    userId: text(),
    referenceId: text(),
    resources: jsonb(),
    requestedUserInfoClaims: jsonb(),
    scopes: jsonb().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
  },
  (table) => [
    index("oauthConsent_clientId_idx").using(
      "btree",
      table.clientId.asc().nullsLast(),
    ),
    index("oauthConsent_userId_idx").using(
      "btree",
      table.userId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.clientId],
      foreignColumns: [oauthClient.clientId],
      name: "oauthConsent_clientId_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: "oauthConsent_userId_fkey",
    }).onDelete("cascade"),
  ],
);

export const oauthClientAssertion = pgTable("oauthClientAssertion", {
  id: text().primaryKey().notNull(),
  expiresAt: timestamp({ withTimezone: true, mode: "string" }).notNull(),
});

export const rateLimit = pgTable(
  "rateLimit",
  {
    id: text().primaryKey().notNull(),
    key: text().notNull(),
    count: integer().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    lastRequest: bigint({ mode: "number" }).notNull(),
  },
  (table) => [unique("rateLimit_key_key").on(table.key)],
);
