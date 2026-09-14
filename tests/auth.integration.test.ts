import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { hashPassword } from "better-auth/crypto";
import {
  DELETE as tokensDELETE,
  GET as tokensGET,
  POST as tokensPOST,
} from "../app/api/agent-tokens/route";
import { POST as mcpPOST } from "../app/mcp/route";
import { getAuth } from "../lib/auth";
import * as brain from "../lib/brain/service";
import { getPool } from "../lib/db";

test(
  "real Postgres authentication, OAuth PKCE, remote MCP and credential boundaries",
  { skip: process.env.AUTH_INTEGRATION_TEST !== "1" },
  async (t) => {
    assert.ok(
      process.env.DATABASE_URL,
      "AUTH_INTEGRATION_TEST requires a migrated Postgres database",
    );
    const ownerId = randomUUID();
    const email = `auth-test-${ownerId}@example.invalid`;
    const password = randomBytes(24).toString("base64url");
    const originalOrigin = process.env.BETTER_AUTH_URL;
    const originalOwner = process.env.BRAIN_OWNER_EMAIL;
    process.env.BRAIN_OWNER_EMAIL = email;
    const clientIds: string[] = [];
    let origin = "";
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers))
          if (value)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        headers.set("x-forwarded-for", req.socket.remoteAddress ?? "127.0.0.1");
        const request = new Request(`${origin}${req.url}`, {
          method: req.method,
          headers,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        });
        let response: Response;
        if (req.url?.startsWith("/mcp"))
          response =
            req.method === "POST"
              ? await mcpPOST(request)
              : new Response(null, { status: 405 });
        else if (req.url === "/api/agent-tokens")
          response = await {
            GET: tokensGET,
            POST: tokensPOST,
            DELETE: tokensDELETE,
          }[req.method as "GET" | "POST" | "DELETE"](request);
        else response = await getAuth().handler(request);
        res.statusCode = response.status;
        for (const [name, value] of response.headers)
          if (name !== "set-cookie") res.setHeader(name, value);
        if (response.headers.getSetCookie().length)
          res.setHeader("set-cookie", response.headers.getSetCookie());
        res.end(Buffer.from(await response.arrayBuffer()));
      } catch (error) {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : "test server failure");
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    origin = `http://127.0.0.1:${address.port}`;
    process.env.BETTER_AUTH_URL = origin;
    t.after(async () => {
      for (const clientId of clientIds)
        await getPool().query(
          'DELETE FROM "oauthClient" WHERE "clientId" = $1',
          [clientId],
        );
      await getPool().query("DELETE FROM brain_pages WHERE owner_id = $1", [
        ownerId,
      ]);
      await getPool().query('DELETE FROM "user" WHERE id = $1', [ownerId]);
      await getPool().query(
        'DELETE FROM "oauthResource" WHERE identifier = $1',
        [`${origin}/mcp`],
      );
      await getPool().end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (originalOrigin) process.env.BETTER_AUTH_URL = originalOrigin;
      else delete process.env.BETTER_AUTH_URL;
      if (originalOwner) process.env.BRAIN_OWNER_EMAIL = originalOwner;
      else delete process.env.BRAIN_OWNER_EMAIL;
    });
    await getPool().query(
      'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,\'Auth test\',$2,true,now(),now())',
      [ownerId, email],
    );
    await getPool().query(
      'INSERT INTO account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2,\'credential\',$2,$3,now(),now())',
      [randomUUID(), ownerId, await hashPassword(password)],
    );
    const json = (body: unknown, cookie?: string) => ({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        origin,
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    const signIn = await fetch(
      `${origin}/api/auth/sign-in/email`,
      json({ email, password }),
    );
    assert.equal(signIn.status, 200, await signIn.clone().text());
    const cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie);
    let tokenId = "";
    let rawToken = "";

    await t.test(
      "public signup is closed and discovery advertises OAuth, CIMD and resource audience",
      async () => {
        const signup = await fetch(
          `${origin}/api/auth/sign-up/email`,
          json({
            email: "intruder@example.invalid",
            name: "Intruder",
            password,
          }),
        );
        assert.ok([400, 403, 404].includes(signup.status));
        const resource = await fetch(
          `${origin}/.well-known/oauth-protected-resource/mcp`,
        );
        assert.equal(resource.status, 200, await resource.clone().text());
        const metadata = await resource.json();
        assert.equal(metadata.resource, `${origin}/mcp`);
        const issuer = metadata.authorization_servers[0];
        const discovery = await fetch(
          `${origin}/.well-known/oauth-authorization-server${new URL(issuer).pathname}`,
        );
        assert.equal(discovery.status, 200, await discovery.clone().text());
        const document = await discovery.json();
        assert.equal(document.client_id_metadata_document_supported, true);
        assert.ok(document.code_challenge_methods_supported.includes("S256"));
        assert.equal(
          document.registration_endpoint,
          `${origin}/api/auth/oauth2/register`,
        );
      },
    );

    await t.test(
      "session management creates a once-visible token and never lists its secret or hash",
      async () => {
        const response = await fetch(
          `${origin}/api/agent-tokens`,
          json(
            {
              name: "Integration test",
              scopes: ["brain:read"],
              expiresInDays: 1,
            },
            cookie,
          ),
        );
        assert.equal(response.status, 201, await response.clone().text());
        const body = await response.json();
        tokenId = body.record.id;
        rawToken = body.token;
        const listing = await (
          await fetch(`${origin}/api/agent-tokens`, { headers: { cookie } })
        ).json();
        assert.ok(
          listing.tokens.some((token: { id: string }) => token.id === tokenId),
        );
        assert.equal(JSON.stringify(listing).includes(rawToken), false);
        assert.equal(JSON.stringify(listing).includes("token_hash"), false);
        const csrf = await fetch(`${origin}/api/agent-tokens`, {
          ...json({ name: "Forbidden", scopes: ["brain:read"] }, cookie),
          headers: {
            "Content-Type": "application/json",
            cookie,
            origin: "https://evil.example",
          },
        });
        assert.equal(csrf.status, 403);
        const escalation = await fetch(`${origin}/api/agent-tokens`, {
          ...json({ name: "Forbidden", scopes: ["brain:write"] }),
          headers: {
            "Content-Type": "application/json",
            authorization: `Bearer ${rawToken}`,
            origin,
          },
        });
        assert.equal(escalation.status, 403);
      },
    );

    await t.test(
      "SDK v2 remote MCP exposes all primitives and denies read-token writes",
      async () => {
        const client = new Client(
          { name: "agent-brain-auth-test", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        const transport = new StreamableHTTPClientTransport(
          new URL(`${origin}/mcp`),
          { requestInit: { headers: { authorization: `Bearer ${rawToken}` } } },
        );
        await client.connect(transport);
        const listed = await client.listTools();
        for (const name of [
          "search",
          "read",
          "write",
          "append",
          "resolve",
          "related",
          "context",
          "pending_embeddings",
          "index_chunks",
        ])
          assert.ok(listed.tools.some((tool) => tool.name === name));
        await assert.rejects(
          client.callTool({
            name: "write",
            arguments: {
              title: "Forbidden page",
              type: "project",
              markdown: "Must not be written",
              expectedVersion: 0,
            },
          }),
          /scope/i,
        );
        for (const name of ["pending_embeddings", "index_chunks"])
          await assert.rejects(
            client.callTool({ name, arguments: {} }),
            /scope/i,
          );
        const prompts = await client.listPrompts();
        assert.ok(
          prompts.prompts.some(
            (prompt) => prompt.name === "nightly_consolidation",
          ),
        );
        await client.close();
      },
    );

    await t.test(
      "MCP chunk indexing covers long pages in bounded batches and enforces versions",
      async (subtest) => {
        const originalFetch = globalThis.fetch;
        let externalCalls = 0;
        subtest.mock.method(
          globalThis,
          "fetch",
          async (...args: Parameters<typeof fetch>) => {
            const [input, init] = args;
            const url = input instanceof Request ? input.url : String(input);
            if (new URL(url).origin !== origin) {
              externalCalls++;
              throw new Error(
                "Chunk indexing must use worker-supplied vectors",
              );
            }
            return originalFetch(input, init);
          },
        );
        const issued = await fetch(
          `${origin}/api/agent-tokens`,
          json(
            {
              name: "Chunk worker integration test",
              scopes: ["brain:maintain"],
              expiresInDays: 1,
            },
            cookie,
          ),
        );
        assert.equal(issued.status, 201, await issued.clone().text());
        const workerToken = (await issued.json()).token;
        const suffix = `Long page suffix ${randomUUID()}`;
        const markdown = `${Array.from(
          { length: 180 },
          (_, index) =>
            `Section ${index}: The project records distinct decisions, their supporting evidence, and the people accountable for subsequent work.\n\n`,
        ).join("")}# Final decision\n\n${suffix}`;
        assert.ok(Buffer.byteLength(markdown, "utf8") > 7_500);
        const page = await brain.write(ownerId, {
          expectedVersion: 0,
          title: `Chunk transport test ${randomUUID()}`,
          type: "project",
          markdown,
        });
        const client = new Client(
          { name: "chunk-worker-contract-test", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        type PendingPage = {
          id: string;
          version: number;
          embeddingModel: string;
          chunkerVersion: string;
          markdown?: string;
          totalChunks: number;
          pendingChunks: number;
          chunks: {
            content: string;
            contentHash: string;
            needsEmbedding: boolean;
          }[];
        };
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
              requestInit: {
                headers: { authorization: `Bearer ${workerToken}` },
              },
            }),
          );
          const listed = await client.listTools();
          assert.equal(
            listed.tools.find((tool) => tool.name === "index_chunks")
              ?.annotations?.readOnlyHint,
            false,
          );
          const pending = await client.callTool({
            name: "pending_embeddings",
            arguments: { limit: 1 },
          });
          assert.equal(pending.isError, undefined);
          const data = pending.structuredContent as { data: PendingPage[] };
          const manifest = data.data.find((entry) => entry.id === page.id);
          assert.ok(manifest);
          assert.ok(manifest.chunks.length > 1);
          assert.ok(
            manifest.chunks.some((chunk) => chunk.content.includes(suffix)),
            "The final section must be exposed to the embedding worker",
          );
          const text = pending.content[0];
          assert.equal(text.type, "text");
          assert.deepEqual(
            JSON.parse(text.type === "text" ? text.text : "null"),
            data.data,
            "Existing clients retain the JSON array payload",
          );
          const embedding = Array.from({ length: 1536 }, () => 0.01);
          let completed = false;
          let batches = 0;
          while (!completed && batches <= manifest.chunks.length) {
            const response = await client.callTool({
              name: "pending_embeddings",
              arguments: { limit: 1, chunkLimit: 1 },
            });
            const [batch] = (
              response.structuredContent as { data: PendingPage[] }
            ).data;
            assert.ok(batch);
            assert.equal(batch.id, page.id);
            assert.equal(batch.markdown, undefined);
            assert.ok(batch.chunks.length <= 1);
            assert.ok(batch.pendingChunks > 0);
            assert.equal(batch.totalChunks, manifest.chunks.length);
            const indexed = await client.callTool({
              name: "index_chunks",
              arguments: {
                ref: page.id,
                expectedVersion: page.version,
                embeddingModel: batch.embeddingModel,
                chunkerVersion: batch.chunkerVersion,
                embeddings: batch.chunks
                  .filter((chunk) => chunk.needsEmbedding)
                  .map(({ contentHash }) => ({ contentHash, embedding })),
              },
            });
            assert.equal(indexed.isError, undefined);
            const status = (
              indexed.structuredContent as {
                data: { indexed: boolean; totalChunks: number };
              }
            ).data;
            assert.equal(status.totalChunks, manifest.chunks.length);
            completed = status.indexed;
            batches++;
            if (batches === 1)
              assert.equal(completed, false, "One chunk is not a full page");
          }
          assert.equal(completed, true);
          const finished = await client.callTool({
            name: "pending_embeddings",
            arguments: { limit: 1, chunkLimit: 1 },
          });
          assert.deepEqual(finished.structuredContent, { data: [] });
          await brain.append(ownerId, {
            ref: page.id,
            expectedVersion: page.version,
            markdown: "A later revision changes the current page.",
          });
          const stale = await client.callTool({
            name: "index_chunks",
            arguments: {
              ref: page.id,
              expectedVersion: page.version,
              embeddingModel: manifest.embeddingModel,
              chunkerVersion: manifest.chunkerVersion,
              embeddings: [],
            },
          });
          assert.equal(stale.isError, true);
          assert.equal(
            (stale.structuredContent as { error: { code: string } }).error.code,
            "VERSION_CONFLICT",
          );
          assert.equal(externalCalls, 0);
        } finally {
          await client.close();
          await getPool().query(
            "DELETE FROM brain_pages WHERE owner_id = $1 AND id = $2",
            [ownerId, page.id],
          );
        }
      },
    );

    await t.test(
      "MCP search preserves array payloads and reports automatic embedding or provider fallback mode",
      async (subtest) => {
        const originalKey = process.env.BRAIN_EMBEDDING_API_KEY;
        const originalEnabled = process.env.BRAIN_QUERY_EMBEDDINGS;
        process.env.BRAIN_EMBEDDING_API_KEY = "test-embedding-key";
        process.env.BRAIN_QUERY_EMBEDDINGS = "true";
        const originalFetch = globalThis.fetch;
        let providerAvailable = true;
        let providerCalls = 0;
        subtest.mock.method(
          globalThis,
          "fetch",
          async (...args: Parameters<typeof fetch>) => {
            const [input, init] = args;
            const url = input instanceof Request ? input.url : String(input);
            if (url === "https://ai-gateway.vercel.sh/v1/embeddings") {
              providerCalls++;
              return providerAvailable
                ? Response.json({
                    data: [
                      { embedding: Array.from({ length: 1536 }, () => 0.01) },
                    ],
                  })
                : new Response(null, { status: 503 });
            }
            assert.equal(new URL(url).origin, origin);
            return originalFetch(input, init);
          },
        );
        const client = new Client(
          { name: "retrieval-contract-test", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
              requestInit: {
                headers: { authorization: `Bearer ${rawToken}` },
              },
            }),
          );
          const { tools } = await client.listTools();
          for (const name of ["search", "context"]) {
            const tool = tools.find((entry) => entry.name === name);
            assert.equal(tool?.annotations?.readOnlyHint, true);
            assert.equal(tool?.annotations?.openWorldHint, true);
          }
          assert.equal(
            tools.find((entry) => entry.name === "read")?.annotations
              ?.openWorldHint,
            false,
          );
          for (const mode of ["hybrid", "text-and-graph"]) {
            providerAvailable = mode === "hybrid";
            const response = await client.callTool({
              name: "search",
              arguments: { query: `Retrieval contract ${randomUUID()}` },
            });
            assert.equal(response.isError, undefined);
            const structured = response.structuredContent as {
              data: unknown[];
              retrieval: {
                mode: string;
                embeddingSource: string;
                embeddingModel: string | null;
              };
            };
            assert.ok(Array.isArray(structured?.data));
            assert.equal(response.content.length, 1);
            const text = response.content[0];
            assert.equal(text.type, "text");
            assert.deepEqual(
              JSON.parse(text.type === "text" ? text.text : "null"),
              structured.data,
            );
            const { retrieval } = structured;
            assert.equal(retrieval.mode, mode);
            assert.equal(
              retrieval.embeddingSource,
              providerAvailable ? "server" : "unavailable",
            );
            assert.equal(
              retrieval.embeddingModel,
              providerAvailable
                ? process.env.EMBEDDING_MODEL || "openai/text-embedding-3-small"
                : null,
            );
          }
          assert.equal(providerCalls, 2);
        } finally {
          await client.close();
          if (originalKey) process.env.BRAIN_EMBEDDING_API_KEY = originalKey;
          else delete process.env.BRAIN_EMBEDDING_API_KEY;
          if (originalEnabled)
            process.env.BRAIN_QUERY_EMBEDDINGS = originalEnabled;
          else delete process.env.BRAIN_QUERY_EMBEDDINGS;
        }
      },
    );

    await t.test(
      "legacy agents can use SDK v2's stateless Streamable HTTP compatibility transport",
      async () => {
        const client = new Client({
          name: "legacy-agent-test",
          version: "1.0.0",
        });
        await client.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            requestInit: { headers: { authorization: `Bearer ${rawToken}` } },
          }),
        );
        assert.ok(
          (await client.listTools()).tools.some(
            (tool) => tool.name === "context",
          ),
        );
        const result = await client.callTool({
          name: "resolve",
          arguments: { name: "No existing entity" },
        });
        assert.equal(result.isError, undefined);
        await client.close();
      },
    );

    await t.test(
      "revoked and expired headless tokens are rejected immediately",
      async () => {
        await getPool().query(
          "UPDATE agent_tokens SET expires_at = now() - interval '1 minute' WHERE id = $1",
          [tokenId],
        );
        assert.equal(
          (
            await fetch(`${origin}/mcp`, {
              ...json({}),
              headers: { authorization: `Bearer ${rawToken}` },
            })
          ).status,
          401,
        );
        await getPool().query(
          "UPDATE agent_tokens SET expires_at = now() + interval '1 day' WHERE id = $1",
          [tokenId],
        );
        const revoke = await fetch(`${origin}/api/agent-tokens`, {
          ...json({ id: tokenId }, cookie),
          method: "DELETE",
        });
        assert.equal(revoke.status, 200);
        assert.equal(
          (
            await fetch(`${origin}/mcp`, {
              ...json({}),
              headers: { authorization: `Bearer ${rawToken}` },
            })
          ).status,
          401,
        );
      },
    );

    await t.test(
      "OAuth authorization requires PKCE, consent, exact callback and a resource-bound token",
      async () => {
        const callback = "https://agent-client.example/callback";
        const registration = await fetch(
          `${origin}/api/auth/oauth2/register`,
          json({
            client_name: "Integration OAuth client",
            redirect_uris: [callback],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: "openid offline_access brain:read",
          }),
        );
        assert.equal(
          registration.status,
          201,
          await registration.clone().text(),
        );
        const registered = await registration.json();
        const clientId = registered.client_id;
        clientIds.push(clientId);
        const verifier = randomBytes(32).toString("base64url");
        const challenge = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        const query = new URLSearchParams({
          client_id: clientId,
          response_type: "code",
          redirect_uri: callback,
          scope: "openid offline_access brain:read",
          resource: `${origin}/mcp`,
          state: randomUUID(),
          code_challenge: challenge,
          code_challenge_method: "S256",
        });
        const noPkce = new URLSearchParams(query);
        noPkce.delete("code_challenge");
        noPkce.delete("code_challenge_method");
        const missing = await fetch(
          `${origin}/api/auth/oauth2/authorize?${noPkce}`,
          { headers: { cookie, accept: "text/html" }, redirect: "manual" },
        );
        const missingUrl =
          missing.headers.get("location") || (await missing.json()).url;
        assert.ok(
          missing.status >= 400 || missingUrl?.includes("error="),
          "public OAuth clients must require PKCE",
        );
        const authorize = await fetch(
          `${origin}/api/auth/oauth2/authorize?${query}`,
          { headers: { cookie, accept: "text/html" }, redirect: "manual" },
        );
        assert.ok(
          [200, 302].includes(authorize.status),
          await authorize.clone().text(),
        );
        const authorizeUrl =
          authorize.headers.get("location") || (await authorize.json()).url;
        const consentUrl = new URL(authorizeUrl, origin);
        assert.equal(consentUrl.pathname, "/consent");
        const tampered = new URLSearchParams(consentUrl.search);
        tampered.set("scope", "brain:write");
        const badConsent = await fetch(
          `${origin}/api/auth/oauth2/consent`,
          json({ accept: true, oauth_query: tampered.toString() }, cookie),
        );
        assert.ok(badConsent.status >= 400);
        const consent = await fetch(
          `${origin}/api/auth/oauth2/consent`,
          json(
            { accept: true, oauth_query: consentUrl.search.slice(1) },
            cookie,
          ),
        );
        assert.equal(consent.status, 200, await consent.clone().text());
        const consentResult = await consent.json();
        const returned = new URL(consentResult.url);
        const code = returned.searchParams.get("code");
        assert.ok(code);
        const tokenBody = {
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: callback,
          resource: `${origin}/mcp`,
        };
        const exchange = await fetch(`${origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(tokenBody),
        });
        assert.equal(exchange.status, 200, await exchange.clone().text());
        const tokens = await exchange.json();
        assert.ok(tokens.access_token);
        assert.ok(tokens.refresh_token);
        const claims = JSON.parse(
          Buffer.from(
            tokens.access_token.split(".")[1],
            "base64url",
          ).toString(),
        );
        assert.equal(claims.sub, ownerId);
        assert.ok([claims.aud].flat().includes(`${origin}/mcp`));
        const oauthClient = new Client(
          { name: "oauth-test", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        await oauthClient.connect(
          new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), {
            requestInit: {
              headers: { authorization: `Bearer ${tokens.access_token}` },
            },
          }),
        );
        assert.ok((await oauthClient.listTools()).tools.length >= 7);
        await oauthClient.close();
        const refreshed = await fetch(`${origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "refresh_token",
            client_id: clientId,
            refresh_token: tokens.refresh_token,
            resource: `${origin}/mcp`,
          }),
        });
        assert.equal(refreshed.status, 200, await refreshed.clone().text());
        assert.ok((await refreshed.json()).access_token);
        const replay = await fetch(`${origin}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(tokenBody),
        });
        assert.ok(replay.status >= 400);
      },
    );

    await t.test(
      "CIMD verifies VS Code's real public metadata and reaches consent without granting access",
      { skip: process.env.CIMD_LIVE_TEST !== "1" },
      async () => {
        const clientId = "https://vscode.dev/oauth/client-metadata.json";
        const previous = await getPool().query(
          'SELECT id FROM "oauthClient" WHERE "clientId" = $1',
          [clientId],
        );
        if (!previous.rows.length) clientIds.push(clientId);
        const document = await fetch(clientId, {
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        assert.equal(document.status, 200);
        const metadata = await document.json();
        assert.equal(metadata.client_id, clientId);
        assert.equal(metadata.token_endpoint_auth_method, "none");
        const callback = metadata.redirect_uris.find((uri: string) =>
          uri.startsWith("https://"),
        );
        assert.ok(callback);
        const query = new URLSearchParams({
          client_id: clientId,
          response_type: "code",
          redirect_uri: callback,
          scope: "brain:read",
          resource: `${origin}/mcp`,
          code_challenge: randomBytes(32).toString("base64url"),
          code_challenge_method: "S256",
          state: randomUUID(),
        });
        const authorize = await fetch(
          `${origin}/api/auth/oauth2/authorize?${query}`,
          { headers: { cookie }, redirect: "manual" },
        );
        const returned =
          authorize.headers.get("location") || (await authorize.json()).url;
        assert.ok(returned);
        assert.equal(new URL(returned, origin).pathname, "/consent");
        const persisted = await getPool().query(
          'SELECT "clientDiscoveryId" FROM "oauthClient" WHERE "clientId" = $1',
          [clientId],
        );
        assert.ok(
          persisted.rows[0]?.clientDiscoveryId,
          "The client must be resolved by CIMD, not DCR",
        );
        const consent = await getPool().query(
          'SELECT id FROM "oauthConsent" WHERE "clientId" = $1 AND "userId" = $2',
          [clientId, ownerId],
        );
        assert.equal(
          consent.rows.length,
          0,
          "The test must not grant VS Code access",
        );
      },
    );

    await t.test(
      "CIMD rejects loopback client metadata URLs at its SSRF boundary",
      async () => {
        const query = new URLSearchParams({
          client_id: "https://127.0.0.1/metadata.json",
          response_type: "code",
          redirect_uri: `${origin}/client/callback`,
          scope: "brain:read",
          resource: `${origin}/mcp`,
          code_challenge: randomBytes(32).toString("base64url"),
          code_challenge_method: "S256",
        });
        const response = await fetch(
          `${origin}/api/auth/oauth2/authorize?${query}`,
          { headers: { cookie }, redirect: "manual" },
        );
        assert.ok(
          response.status >= 400 ||
            response.headers.get("location")?.includes("error="),
        );
      },
    );
  },
);
