import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins/jwt";
import { getPool } from "@/lib/db";

export const BRAIN_SCOPES = [
  "brain:read",
  "brain:write",
  "brain:maintain",
] as const;
export type BrainScope = (typeof BRAIN_SCOPES)[number];

export function isAuthConfigured() {
  return Boolean(
    process.env.DATABASE_URL &&
      process.env.BETTER_AUTH_URL &&
      process.env.BETTER_AUTH_SECRET &&
      process.env.BRAIN_OWNER_EMAIL,
  );
}

export function appOrigin() {
  const value = process.env.BETTER_AUTH_URL;
  if (!value) throw new Error("BETTER_AUTH_URL is not configured.");
  const url = new URL(value);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      "BETTER_AUTH_URL must be an application origin, without a path.",
    );
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("BETTER_AUTH_URL must use HTTPS (except localhost).");
  return url.origin;
}

export function mcpResource() {
  return `${appOrigin()}/mcp`;
}

export function authOptions() {
  const origin = appOrigin();
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters.");
  if (!process.env.BRAIN_OWNER_EMAIL)
    throw new Error("BRAIN_OWNER_EMAIL is required.");
  return {
    appName: "Agent Brain",
    baseURL: origin,
    secret,
    database: getPool(),
    trustedOrigins: [origin],
    // Owner creation is a local administrative operation; there is never a public signup race.
    disabledPaths: ["/sign-up/email", "/token"],
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
    },
    account: { encryptOAuthTokens: true },
    // Vercel replaces this header at its ingress; do not trust arbitrary proxy chains.
    advanced: { ipAddress: { ipAddressHeaders: ["x-forwarded-for"] } },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: "database" as const,
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/oauth2/register": { window: 3600, max: 20 },
      },
    },
    plugins: [
      jwt(),
      // DCR is an explicit compatibility fallback for agents that do not support CIMD yet.
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource: mcpResource(),
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          ...BRAIN_SCOPES,
        ],
        accessTokenExpiresIn: 60 * 15,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
    ],
  };
}

let instance:
  | ReturnType<typeof betterAuth<ReturnType<typeof authOptions>>>
  | undefined;
export function getAuth() {
  instance ??= betterAuth(authOptions());
  return instance;
}

export async function getSession(requestHeaders: Headers) {
  if (!isAuthConfigured()) return null;
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (
    session?.user.email.toLowerCase() !==
    process.env.BRAIN_OWNER_EMAIL?.trim().toLowerCase()
  )
    return null;
  return session;
}
