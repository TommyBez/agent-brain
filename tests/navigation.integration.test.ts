import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { Pool } from "pg";
import type { BrainPage, PageType } from "../lib/brain/types";

// These acceptance tests require a running Next build and an isolated fixture
// owner. They deliberately do not import or mock App Router handlers/components.
function renderedHtml(html: string) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "");
}

function renderedText(html: string) {
  return renderedHtml(html)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ");
}

function editable(page: BrainPage) {
  return {
    expectedVersion: page.version,
    title: page.title,
    type: page.type,
    summary: page.summary,
    markdown: page.markdown,
    aliases: page.aliases,
    tags: page.tags,
    links: page.links.map((link) => ({
      targetRef: link.targetId,
      type: link.type,
      label: link.label,
    })),
    reason: "Next HTTP acceptance update",
  };
}

test(
  "running Next streams authenticated routes and invalidates rendered data after API/MCP writes",
  {
    skip: process.env.RUN_NEXT_TESTS !== "1",
    timeout: 180_000,
  },
  async (t) => {
    assert.ok(
      process.env.BRAIN_TEST_BASE_URL,
      "Set BRAIN_TEST_BASE_URL to the isolated localhost Next server",
    );
    const origin = new URL(process.env.BRAIN_TEST_BASE_URL);
    assert.equal(origin.protocol, "http:");
    assert.ok(
      ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname),
      "Next acceptance tests only run against loopback HTTP",
    );
    assert.equal(origin.pathname, "/");
    assert.equal(origin.search, "");
    assert.equal(origin.username, "");
    assert.equal(origin.password, "");
    const email = process.env.BRAIN_TEST_EMAIL;
    const password = process.env.BRAIN_TEST_PASSWORD;
    assert.ok(email, "Set BRAIN_TEST_EMAIL for the fixture owner");
    assert.ok(
      email.endsWith(".invalid"),
      "Use a dedicated .invalid test fixture owner",
    );
    assert.ok(password, "Set BRAIN_TEST_PASSWORD for that fixture owner");
    assert.ok(
      process.env.BRAIN_TEST_DATABASE_URL,
      "Set the fixture database URL for exact-ID cleanup and the streaming lock test",
    );
    const db = new Pool({
      connectionString: process.env.BRAIN_TEST_DATABASE_URL,
      max: 2,
      connectionTimeoutMillis: 10_000,
    });
    let cookie = "";
    let ownerId = "";
    let tokenId = "";
    let token = "";
    const pageIds: string[] = [];
    const prefix = `NextAcceptance${randomUUID().replaceAll("-", "")}`;
    const bodyMarker = `${prefix}PrivateMarkdown`;

    const request = (
      path: string,
      init: RequestInit = {},
      authenticated = true,
    ) =>
      fetch(new URL(path, origin), {
        ...init,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: {
          "User-Agent": "Mozilla/5.0 NextAcceptance",
          ...(authenticated && cookie ? { cookie } : {}),
          ...init.headers,
        },
      });
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { "Content-Type": "application/json", origin: origin.origin },
      body: JSON.stringify(body),
    });
    const html = async (path: string) => {
      const response = await request(path);
      assert.equal(response.status, 200, `Expected rendered HTML for ${path}`);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      return response.text();
    };

    t.after(async () => {
      try {
        if (tokenId && cookie) {
          const revoked = await request(
            "/api/agent-tokens",
            json("DELETE", { id: tokenId }),
          );
          assert.equal(revoked.status, 200, "Revoke the temporary test token");
        }
        if (ownerId) {
          // Match both the verified login owner and only IDs created by this run.
          const fixture = await db.query(
            'SELECT id FROM "user" WHERE id=$1 AND email=$2',
            [ownerId, email],
          );
          assert.equal(
            fixture.rowCount,
            1,
            "Cleanup DB must match the authenticated test fixture",
          );
          await db.query(
            "DELETE FROM brain_pages WHERE owner_id=$1 AND id=ANY($2::uuid[])",
            [ownerId, pageIds],
          );
          if (tokenId)
            await db.query(
              "DELETE FROM agent_tokens WHERE owner_id=$1 AND id=$2",
              [ownerId, tokenId],
            );
        }
        if (cookie) {
          const signedOut = await request(
            "/api/auth/sign-out",
            json("POST", {}),
          );
          assert.equal(signedOut.status, 200, "Remove this test's session");
        }
      } finally {
        await db.end();
      }
    });

    const signIn = await request(
      "/api/auth/sign-in/email",
      json("POST", { email, password }),
      false,
    );
    assert.equal(
      signIn.status,
      200,
      "The prepared test owner must be able to sign in",
    );
    cookie = signIn.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    assert.ok(cookie, "Better Auth must return a session cookie");
    const identity = (await signIn.json()) as {
      user: { id: string; email: string };
    };
    assert.equal(identity.user.email, email);
    const fixture = await db.query(
      'SELECT id FROM "user" WHERE id=$1 AND email=$2',
      [identity.user.id, email],
    );
    assert.equal(
      fixture.rowCount,
      1,
      "The HTTP server and cleanup connection must use the same fixture database",
    );
    ownerId = identity.user.id;

    async function createPage(
      title: string,
      markdown: string,
      links: { targetRef: string; type: "references" }[] = [],
      type: PageType = "note",
    ) {
      const response = await request(
        "/api/brain/pages",
        json("POST", {
          title,
          type,
          markdown,
          expectedVersion: 0,
          links,
          reason: "Temporary Next HTTP acceptance fixture",
        }),
      );
      assert.equal(
        response.status,
        201,
        "Create an isolated acceptance page through HTTP",
      );
      const { page } = (await response.json()) as { page: BrainPage };
      pageIds.push(page.id);
      return page;
    }

    const connected = await createPage(
      `${prefix}Connection`,
      "Temporary typed-link destination.",
    );
    let page = await createPage(
      `${prefix}Page`,
      `# Server rendered knowledge\n\n${bodyMarker}`,
      [{ targetRef: connected.id, type: "references" }],
    );
    const project = await createPage(
      `${prefix}Project`,
      "Temporary project collection fixture.",
      [],
      "project",
    );

    await t.test(
      "plural collection routes render their own heading, links, and type-scoped search results",
      async () => {
        for (const [path, title] of [
          ["/people", "People"],
          ["/clients", "Clients"],
          ["/projects", "Projects"],
          ["/articles", "Articles"],
          ["/decisions", "Decisions"],
          ["/notes", "Notes"],
        ]) {
          const collection = renderedHtml(await html(`${path}?q=${prefix}`));
          const heading = collection.match(/<h1\b[^>]*>[\s\S]*?<\/h1>/)?.[0];
          assert.ok(heading, `Expected a heading on ${path}`);
          assert.match(
            renderedText(heading),
            new RegExp(`^\\s*${title}\\s*\\.?\\s*$`),
          );
          assert.ok(
            collection.includes(`href="${path}"`),
            `Collections navigation must link directly to ${path}`,
          );
        }

        const projects = renderedHtml(
          await html(`/projects?q=${prefix}&type=note`),
        );
        assert.ok(projects.includes(`href="/pages/${project.id}"`));
        assert.ok(!renderedText(projects).includes(page.title));
        assert.ok(!renderedText(projects).includes(connected.title));
        assert.ok(projects.includes('href="/pages/new?type=project"'));
        assert.ok(projects.includes(`value="${prefix}"`));

        const notes = renderedHtml(
          await html(`/notes?q=${prefix}&type=project`),
        );
        assert.ok(notes.includes(`href="/pages/${page.id}"`));
        assert.ok(notes.includes(`href="/pages/${connected.id}"`));
        assert.ok(!renderedText(notes).includes(project.title));
        assert.ok(notes.includes('href="/pages/new?type=note"'));

        const unmatched = renderedText(await html(`/projects?q=${page.title}`));
        assert.ok(unmatched.includes("Nothing here, yet."));
        assert.ok(!unmatched.includes(project.title));

        const laterResults = renderedHtml(
          await html(`/projects?q=${prefix}&sort=title&offset=50`),
        );
        assert.ok(
          laterResults.includes(`href="/projects?q=${prefix}&amp;sort=title"`),
          "Pagination must preserve the collection, search and sort",
        );
      },
    );

    await t.test(
      "private page content, links, and history exist in server HTML without executing client JavaScript",
      async () => {
        const library = renderedHtml(await html(`/?q=${prefix}`));
        assert.ok(renderedText(library).includes(page.title));
        assert.ok(
          library.includes(`href="/pages/${page.id}"`),
          "Library rows use navigable links",
        );
        const detail = renderedHtml(await html(`/pages/${page.id}`));
        assert.match(detail, /<h1[^>]*>Server rendered knowledge<\/h1>/);
        assert.ok(
          renderedText(detail).includes(bodyMarker),
          "The Markdown body must be HTML, not only serialized Flight props",
        );
        assert.ok(
          detail.includes(`href="/pages/${connected.id}"`),
          "Typed connections are real links in server HTML",
        );
        assert.ok(detail.includes(`href="/pages/${page.id}/edit"`));
        const history = renderedHtml(await html(`/pages/${page.id}/history`));
        assert.ok(history.includes(`href="/pages/${page.id}/history/1"`));
        const revision = renderedText(
          await html(`/pages/${page.id}/history/1`),
        );
        assert.ok(revision.includes(bodyMarker));
        assert.ok(revision.includes("Reading version 1"));
        const editor = renderedHtml(await html(`/pages/${page.id}/edit`));
        assert.ok(
          editor.includes(`value="${page.title}"`),
          "Editor inputs receive server-fetched initial values",
        );
        assert.ok(editor.includes(bodyMarker));
      },
    );

    await t.test(
      "history and activity paginate past fifty entries and old revision URLs retain snapshot metadata",
      async () => {
        const originalTitle = `${prefix}OriginalTitle`;
        const originalBody = `${prefix}OriginalBody`;
        const historical = await createPage(originalTitle, originalBody);
        // Seed a long history in the isolated fixture without fifty HTTP writes.
        await db.query(
          `INSERT INTO brain_revisions (owner_id,page_id,version,snapshot,reason,source)
           SELECT $1,$2,n,$3::jsonb || jsonb_build_object('version',n),$4 || n,'acceptance'
           FROM generate_series(2,51) AS n`,
          [
            ownerId,
            historical.id,
            JSON.stringify(historical),
            `${prefix}Revision`,
          ],
        );
        await db.query(
          `INSERT INTO brain_activity (owner_id,page_id,action,version,reason,source)
           SELECT $1,$2,'write',n,$3 || n,'acceptance' FROM generate_series(2,51) AS n`,
          [ownerId, historical.id, `${prefix}Revision`],
        );
        await db.query(
          "UPDATE brain_pages SET version=51 WHERE owner_id=$1 AND id=$2",
          [ownerId, historical.id],
        );
        const changed = await request(
          `/api/brain/pages/${historical.id}`,
          json("PATCH", {
            ...editable(historical),
            expectedVersion: 51,
            title: `${prefix}CurrentTitle`,
            summary: `${prefix}CurrentSummary`,
            type: "project",
            markdown: `${prefix}CurrentBody`,
          }),
        );
        assert.equal(changed.status, 200);

        const firstHistory = renderedHtml(
          await html(`/pages/${historical.id}/history`),
        );
        assert.ok(
          firstHistory.includes(
            `href="/pages/${historical.id}/history?offset=50"`,
          ),
        );
        assert.ok(
          !firstHistory.includes(`href="/pages/${historical.id}/history/1"`),
        );
        const olderHistory = renderedHtml(
          await html(`/pages/${historical.id}/history?offset=50`),
        );
        assert.ok(
          olderHistory.includes(`href="/pages/${historical.id}/history/1"`),
        );
        assert.ok(
          olderHistory.includes(`href="/pages/${historical.id}/history"`),
        );
        const oldest = renderedHtml(
          await html(`/pages/${historical.id}/history/1`),
        );
        assert.ok(oldest.includes(`<h1>${originalTitle}</h1>`));
        assert.ok(oldest.includes(originalBody));
        assert.ok(!oldest.includes(`${prefix}CurrentTitle`));
        assert.ok(!oldest.includes(`${prefix}CurrentSummary`));
        assert.ok(renderedText(oldest).includes("Reading version 1"));

        const activity = renderedHtml(await html("/activity"));
        assert.ok(activity.includes('href="/activity?offset=50"'));
        const olderActivity = renderedHtml(await html("/activity?offset=50"));
        assert.ok(olderActivity.includes('href="/activity"'));
        const expected = await db.query<{ reason: string }>(
          "SELECT reason FROM brain_activity WHERE owner_id=$1 ORDER BY created_at DESC,id DESC LIMIT 50 OFFSET 50",
          [ownerId],
        );
        assert.ok(expected.rows.length > 0);
        for (const item of expected.rows)
          assert.ok(renderedText(olderActivity).includes(item.reason));
      },
    );

    await t.test(
      "navigation and collection heading stream before a blocked database result",
      async () => {
        const lock = await db.connect();
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
        let released = false;
        try {
          await lock.query("BEGIN");
          await lock.query("SET LOCAL lock_timeout = '5s'");
          await lock.query(
            "SET LOCAL idle_in_transaction_session_timeout = '15s'",
          );
          await lock.query("LOCK TABLE brain_pages IN ACCESS EXCLUSIVE MODE");
          // A unique query cannot reuse the data entry warmed by the preceding test.
          const response = await request(
            `/projects?q=${project.title}&offset=0`,
          );
          assert.equal(response.status, 200);
          assert.ok(response.body);
          reader = response.body.getReader();
          const decoder = new TextDecoder();
          let received = "";
          while (
            !renderedHtml(received).includes('href="/graph"') ||
            !/<h1[^>]*>Projects/.test(renderedHtml(received))
          ) {
            const chunk = await reader.read();
            assert.equal(
              chunk.done,
              false,
              "The response must stream its shell while the page query is blocked",
            );
            received += decoder.decode(chunk.value, { stream: true });
          }
          assert.ok(
            !renderedHtml(received).includes(
              `<strong>${project.title}</strong>`,
            ),
            "Private results must not be required to send the shell",
          );
          await lock.query("ROLLBACK");
          released = true;
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            received += decoder.decode(chunk.value, { stream: true });
          }
          received += decoder.decode();
          assert.ok(
            renderedHtml(received).includes(
              `<strong>${project.title}</strong>`,
            ),
            "The server must stream actual page rows after the database resumes",
          );
        } finally {
          if (!released) await lock.query("ROLLBACK").catch(() => {});
          await reader?.cancel().catch(() => {});
          lock.release();
        }
      },
    );

    await t.test(
      "API writes immediately refresh cached readers, lists, backlinks, and history",
      async () => {
        await html(`/pages/${connected.id}`);
        const changedTitle = `${prefix}ChangedByHttp`;
        const changedBody = `${bodyMarker}UpdatedByHttp`;
        const response = await request(
          `/api/brain/pages/${page.id}`,
          json("PATCH", {
            ...editable(page),
            title: changedTitle,
            markdown: `# HTTP revision\n\n${changedBody}`,
          }),
        );
        assert.equal(response.status, 200);
        page = ((await response.json()) as { page: BrainPage }).page;
        assert.equal(page.version, 2);
        assert.ok(
          renderedText(await html(`/pages/${page.id}`)).includes(changedBody),
        );
        assert.ok(
          renderedText(await html(`/?q=${prefix}`)).includes(changedTitle),
        );
        assert.ok(
          renderedText(await html(`/pages/${connected.id}`)).includes(
            changedTitle,
          ),
          "A target's backlinks must invalidate when its source title changes",
        );
        assert.ok(
          renderedHtml(await html(`/pages/${page.id}/history`)).includes(
            `href="/pages/${page.id}/history/2"`,
          ),
        );
        assert.ok(
          renderedText(await html(`/pages/${page.id}/history/1`)).includes(
            bodyMarker,
          ),
          "Previous revisions retain their original content",
        );
      },
    );

    await t.test(
      "headless MCP writes invalidate the same cached server-rendered page",
      async () => {
        const issued = await request(
          "/api/agent-tokens",
          json("POST", {
            name: prefix,
            scopes: ["brain:read", "brain:write"],
            expiresInDays: 1,
          }),
        );
        assert.equal(issued.status, 201);
        const credential = (await issued.json()) as {
          token: string;
          record: { id: string };
        };
        token = credential.token;
        tokenId = credential.record.id;
        const client = new Client(
          { name: "next-http-acceptance", version: "1.0.0" },
          { versionNegotiation: { mode: { pin: "2026-07-28" } } },
        );
        try {
          await client.connect(
            new StreamableHTTPClientTransport(new URL("/mcp", origin), {
              requestInit: { headers: { authorization: `Bearer ${token}` } },
            }),
          );
          await html(`/pages/${page.id}`);
          const marker = `${bodyMarker}AppendedByMcp`;
          const response = await client.callTool({
            name: "append",
            arguments: {
              ref: page.id,
              expectedVersion: page.version,
              markdown: marker,
              reason: "Next HTTP acceptance MCP invalidation",
            },
          });
          assert.notEqual(
            response.isError,
            true,
            "Headless append must succeed",
          );
          page = (response.structuredContent as { data: BrainPage }).data;
          assert.equal(page.version, 3);
          assert.ok(
            renderedText(await html(`/pages/${page.id}`)).includes(marker),
            "MCP mutation must expire the reader cache without a browser refresh API call",
          );
          assert.ok(
            renderedHtml(await html(`/pages/${page.id}/history`)).includes(
              `href="/pages/${page.id}/history/3"`,
            ),
          );
        } finally {
          await client.close();
        }
      },
    );

    await t.test(
      "unauthenticated requests cannot reuse private HTML after caches are warm",
      async () => {
        for (const path of [
          "/",
          `/projects?q=${prefix}`,
          `/notes?q=${prefix}`,
          `/pages/${page.id}`,
          `/pages/${page.id}/edit`,
          `/pages/${page.id}/history`,
          `/pages/${page.id}/history/1`,
          "/graph",
          "/activity",
          "/agents",
          "/operations",
        ]) {
          await html(path);
          const response = await request(path, {}, false);
          const content = await response.text();
          assert.ok(
            !content.includes(bodyMarker),
            `Private Markdown escaped authentication on ${path}`,
          );
          assert.ok(
            !content.includes(page.title),
            `Private title escaped authentication on ${path}`,
          );
          assert.ok(
            !content.includes(project.title),
            `Private project escaped authentication on ${path}`,
          );
          assert.ok(
            !content.includes(email),
            `Owner identity escaped authentication on ${path}`,
          );
          const redirect = response.headers.get("location") || content;
          assert.ok(
            redirect.includes("/sign-in"),
            `Unauthenticated ${path} must redirect to sign-in`,
          );
        }
        const withHeadlessToken = await request(
          `/pages/${page.id}`,
          { headers: { authorization: `Bearer ${token}` } },
          false,
        );
        assert.ok(
          !(await withHeadlessToken.text()).includes(bodyMarker),
          "An agent token does not substitute for an interactive workspace session",
        );
      },
    );
  },
);
