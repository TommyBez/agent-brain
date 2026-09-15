import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";

function renderedHtml(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

test(
  "Next renders verified OAuth client details before hydration and preserves signed login parameters",
  { skip: process.env.RUN_NEXT_TESTS !== "1", timeout: 60_000 },
  async (t) => {
    assert.ok(process.env.BRAIN_TEST_BASE_URL);
    const origin = new URL(process.env.BRAIN_TEST_BASE_URL);
    assert.equal(origin.protocol, "http:");
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname));
    const email = process.env.BRAIN_TEST_EMAIL;
    const password = process.env.BRAIN_TEST_PASSWORD;
    assert.ok(email?.endsWith(".invalid"));
    assert.ok(password);
    assert.ok(process.env.BRAIN_TEST_DATABASE_URL);
    const db = new Pool({
      connectionString: process.env.BRAIN_TEST_DATABASE_URL,
      connectionTimeoutMillis: 10_000,
    });
    let cookie = "";
    let clientId = "";
    const request = (path: string, init: RequestInit = {}) =>
      fetch(new URL(path, origin), {
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        ...init,
        headers: {
          cookie,
          "User-Agent": "Mozilla/5.0 ConsentAcceptance",
          ...init.headers,
        },
      });
    const json = (body: unknown): RequestInit => ({
      method: "POST",
      headers: { "Content-Type": "application/json", origin: origin.origin },
      body: JSON.stringify(body),
    });
    t.after(async () => {
      try {
        if (clientId)
          await db.query('DELETE FROM "oauthClient" WHERE "clientId"=$1', [
            clientId,
          ]);
        if (cookie) {
          const result = await request("/api/auth/sign-out", json({}));
          assert.equal(result.status, 200);
        }
      } finally {
        await db.end();
      }
    });

    const signIn = await request(
      "/api/auth/sign-in/email",
      json({ email, password }),
    );
    assert.equal(signIn.status, 200);
    const identity = (await signIn.json()) as { user: { id: string } };
    const fixture = await db.query(
      'SELECT id FROM "user" WHERE id=$1 AND email=$2',
      [identity.user.id, email],
    );
    assert.equal(
      fixture.rowCount,
      1,
      "Cleanup database must be the authenticated fixture",
    );
    cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie);

    const name = `ConsentAcceptance${randomUUID()}`;
    const callback = "http://127.0.0.1:49152/callback";
    const registration = await request(
      "/api/auth/oauth2/register",
      json({
        client_name: name,
        application_type: "native",
        redirect_uris: [callback],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "brain:read offline_access",
      }),
    );
    assert.equal(registration.status, 201, await registration.clone().text());
    clientId = ((await registration.json()) as { client_id: string }).client_id;
    assert.ok(clientId);
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: callback,
      scope: "brain:read offline_access",
    });

    await t.test(
      "client identity and permissions are server-rendered",
      async () => {
        const response = await request(`/consent?${params}`);
        assert.equal(response.status, 200);
        const content = renderedHtml(await response.text());
        assert.ok(
          content.includes(name),
          "Identity must appear in HTML, not only an RSC script or client fetch",
        );
        assert.ok(
          content.includes("Read and search your pages, links and context"),
        );
        assert.match(content, /<button\b[^>]*>Allow access<\/button>/);
        assert.doesNotMatch(content, /<button\b[^>]*\sdisabled(?:=|[\s>])/);
      },
    );

    await t.test(
      "unknown clients show a server error and no approval action",
      async () => {
        const response = await request(
          `/consent?client_id=unknown-${randomUUID()}`,
        );
        const content = renderedHtml(await response.text());
        assert.ok(
          content.includes("This authorization request could not be verified."),
        );
        assert.ok(!content.includes("Allow access"));
      },
    );

    await t.test(
      "expired sessions retain repeated signed OAuth parameters",
      async () => {
        params.append("ba_param", "client_id");
        params.append("ba_param", "redirect_uri");
        const response = await request(`/consent?${params}`, {
          headers: { cookie: "" },
        });
        let destination = response.headers.get("location");
        if (!destination) {
          const content = await response.text();
          destination =
            content
              .match(/http-equiv="refresh" content="[^;]+;url=([^"]+)"/)?.[1]
              ?.replaceAll("&amp;", "&") ?? null;
        }
        assert.ok(destination, "Authentication must redirect to sign-in");
        const url = new URL(destination, origin);
        assert.equal(url.pathname, "/sign-in");
        assert.deepEqual(url.searchParams.getAll("ba_param"), [
          "client_id",
          "redirect_uri",
        ]);
        assert.equal(url.searchParams.get("client_id"), clientId);
      },
    );
  },
);
