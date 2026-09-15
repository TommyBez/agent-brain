import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import test from "node:test";
import { mcp } from "@better-auth/mcp";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { jwt } from "better-auth/plugins/jwt";
import { consentSignInHref } from "../lib/auth-navigation";

test("signed consent resumes through the installed OAuth client and provider after session loss", async (t) => {
  const origin = "https://brain.example.invalid";
  const resource = `${origin}/mcp`;
  const callback = "http://127.0.0.1:49152/callback";
  const email = "consent-resumption@example.invalid";
  const password = randomBytes(24).toString("base64url");
  const provider = betterAuth({
    baseURL: origin,
    secret: "consent-resumption-test-secret-at-least-32-characters",
    trustedOrigins: [origin],
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      jwks: [],
      oauthClient: [],
      oauthResource: [],
      oauthClientResource: [],
      oauthRefreshToken: [],
      oauthAccessToken: [],
      oauthConsent: [],
      oauthClientAssertion: [],
    }),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    logger: { disabled: true },
    plugins: [
      jwt(),
      mcp({
        loginPage: "/sign-in",
        consentPage: "/consent",
        resource,
        scopes: ["brain:read", "brain:write", "offline_access"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
    ],
  });
  const post = (path: string, body: unknown, cookie = "") =>
    provider.handler(
      new Request(`${origin}/api/auth${path}`, {
        method: "POST",
        headers: {
          origin,
          cookie,
          "Content-Type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
  const cookieFrom = (response: Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
  const onRequest = oauthProviderClient().fetchPlugins[0].hooks.onRequest;
  const clientPost = async (
    pageUrl: URL,
    path: string,
    body: Record<string, unknown>,
    cookie = "",
  ) => {
    const context: Parameters<typeof onRequest>[0] = {
      url: `${origin}/api/auth${path}`,
      method: "POST",
      headers: new Headers({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
      signal: new AbortController().signal,
    };
    const originalWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { search: pageUrl.search } },
    });
    try {
      await onRequest(context);
    } finally {
      if (originalWindow)
        Object.defineProperty(globalThis, "window", originalWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
    return post(path, JSON.parse(context.body), cookie);
  };

  const signup = await post("/sign-up/email", {
    email,
    password,
    name: "Consent resumption fixture",
  });
  assert.equal(signup.status, 200, await signup.clone().text());
  const originalCookie = cookieFrom(signup);
  assert.ok(originalCookie);

  const registration = await post("/oauth2/register", {
    client_name: "Consent resumption test",
    application_type: "native",
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "brain:read offline_access",
  });
  assert.equal(registration.status, 201, await registration.clone().text());
  const { client_id: clientId } = await registration.json();
  const verifier = randomBytes(32).toString("base64url");
  const state = randomUUID();
  const authorization = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: callback,
    scope: "brain:read offline_access",
    resource,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorize = await provider.handler(
    new Request(`${origin}/api/auth/oauth2/authorize?${authorization}`, {
      headers: { cookie: originalCookie, accept: "application/json" },
    }),
  );
  assert.equal(authorize.status, 200, await authorize.clone().text());
  const consentUrl = new URL((await authorize.json()).url, origin);
  assert.equal(consentUrl.pathname, "/consent");
  assert.ok(consentUrl.searchParams.get("sig"));
  assert.ok(consentUrl.searchParams.getAll("ba_param").length > 1);

  const signout = await post("/sign-out", {}, originalCookie);
  assert.equal(signout.status, 200);
  const session = await provider.handler(
    new Request(`${origin}/api/auth/get-session`, {
      headers: { cookie: originalCookie },
    }),
  );
  assert.equal(await session.json(), null);

  // Next exposes repeated search parameters as arrays. Exercise the same
  // conversion used by the consent Server Component with provider-signed data.
  const query: Record<string, string | string[]> = {};
  for (const key of new Set(consentUrl.searchParams.keys())) {
    const values = consentUrl.searchParams.getAll(key);
    query[key] = values.length === 1 ? values[0] : values;
  }
  const loginUrl = new URL(consentSignInHref(query), origin);
  assert.equal(loginUrl.pathname, "/sign-in");
  assert.equal(loginUrl.searchParams.get("returnTo"), null);
  assert.deepEqual(
    [...loginUrl.searchParams.entries()].sort(),
    [...consentUrl.searchParams.entries()].sort(),
  );

  await t.test(
    "tampering with the forwarded query cannot create a session",
    async () => {
      const tamperedUrl = new URL(loginUrl);
      tamperedUrl.searchParams.set("scope", "brain:write");
      const rejected = await clientPost(tamperedUrl, "/sign-in/email", {
        email,
        password,
        callbackURL: "/",
      });
      assert.equal(rejected.status, 400, await rejected.clone().text());
      assert.equal((await rejected.json()).error, "invalid_signature");
      assert.equal(rejected.headers.getSetCookie().length, 0);
    },
  );

  await t.test(
    "the provider overrides the home fallback, then consent and PKCE finish",
    async () => {
      const signedIn = await clientPost(loginUrl, "/sign-in/email", {
        email,
        password,
        callbackURL: "/",
      });
      assert.equal(signedIn.status, 200, await signedIn.clone().text());
      const result = await signedIn.json();
      const resumedUrl = new URL(result.url, origin);
      assert.equal(resumedUrl.pathname, "/consent");
      for (const key of ["client_id", "state", "resource", "code_challenge"])
        assert.equal(resumedUrl.searchParams.get(key), authorization.get(key));
      const newCookie = cookieFrom(signedIn);
      assert.ok(newCookie);
      const consent = await clientPost(
        resumedUrl,
        "/oauth2/consent",
        { accept: true },
        newCookie,
      );
      assert.equal(consent.status, 200, await consent.clone().text());
      const returned = new URL((await consent.json()).url);
      assert.equal(`${returned.origin}${returned.pathname}`, callback);
      assert.equal(returned.searchParams.get("state"), state);
      const code = returned.searchParams.get("code");
      assert.ok(code);
      const exchange = await provider.handler(
        new Request(`${origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: clientId,
            code,
            code_verifier: verifier,
            redirect_uri: callback,
            resource,
          }),
        }),
      );
      assert.equal(exchange.status, 200, await exchange.clone().text());
      assert.ok((await exchange.json()).access_token);
    },
  );
});
