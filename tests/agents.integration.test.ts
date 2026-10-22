import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { PATCH as pagePATCH } from "../app/api/brain/pages/[id]/route";
import { POST as pagesPOST } from "../app/api/brain/pages/route";
import { createAgentToken } from "../lib/agent-tokens";
import {
  AuthError,
  assertOAuthPrincipal,
  type Principal,
  principalFromAgentToken,
} from "../lib/auth-principal";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";
import { applyConsolidationChangeSet } from "../lib/maintenance/consolidator/store";
import {
  listAgents,
  ownerActor,
  resolveActor,
  setAgentDisabled,
  systemActor,
  updateAgent,
} from "../lib/tasks/actors";
import { changeSet } from "./helpers/consolidator-store";

const code = (expected: string) => (error: unknown) =>
  (error instanceof AuthError || error instanceof BrainError) &&
  error.code === expected;

test(
  "agent registry, request identity, disable and revision signing",
  { skip: process.env.RUN_DB_TESTS !== "1" },
  async (t) => {
    const pool = getPool();
    // agent_tokens and the OAuth allowlist need a real, allowlisted user.
    const ownerId = randomUUID();
    const email = `agents-test-${ownerId}@example.invalid`;
    const outsider = `agents-test-${randomUUID()}`;
    const clientId = `agents-test-client-${randomUUID()}`;
    const originalOwner = process.env.BRAIN_OWNER_EMAIL;
    process.env.BRAIN_OWNER_EMAIL = [originalOwner, email]
      .filter(Boolean)
      .join(",");
    const nextCache = createRequire(import.meta.url)(
      "next/cache",
    ) as typeof import("next/cache");
    t.mock.method(nextCache, "revalidateTag", () => {});
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Agents Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    await pool.query(
      `INSERT INTO "oauthClient" (id,"clientId",name,"redirectUris") VALUES ($1,$2,'Codex Desktop','[]'::jsonb)`,
      [randomUUID(), clientId],
    );
    const tokenPrincipal = async (scopes = ["brain:read", "brain:write"]) => {
      const created = await createAgentToken(ownerId, {
        name: "Headless worker",
        scopes,
      });
      return {
        raw: created.token,
        id: created.record.id,
        principal: await principalFromAgentToken(created.token),
      };
    };
    const oauth = (id = clientId): Principal => ({
      ownerId,
      scopes: ["brain:read", "brain:write"],
      kind: "oauth",
      clientId: id,
    });
    const revisionActor = async (pageId: string, version: number) =>
      (
        await pool.query(
          `SELECT r.actor_agent_id AS revision, a.actor_agent_id AS activity
           FROM brain_revisions r JOIN brain_activity a ON a.owner_id = r.owner_id AND a.page_id = r.page_id AND a.version = r.version
           WHERE r.owner_id = $1 AND r.page_id = $2 AND r.version = $3`,
          [ownerId, pageId, version],
        )
      ).rows[0];

    try {
      await t.test(
        "owner and system agents are registered once, even concurrently",
        async () => {
          const owners = await Promise.all(
            Array.from({ length: 5 }, () => ownerActor(ownerId)),
          );
          assert.equal(new Set(owners.map((owner) => owner.agentId)).size, 1);
          assert.equal(owners[0].agent.kind, "owner");
          assert.equal(owners[0].agent.label, "Agents Owner");
          assert.equal(owners[0].agent.labelVerified, true);
          assert.equal(owners[0].credential, "session");
          assert.equal(owners[0].claimOnRequest, false);
          const session = await resolveActor(ownerId, {
            ownerId,
            scopes: [],
            kind: "session",
          });
          assert.equal(session.agentId, owners[0].agentId);

          const [consolidator, keeper, again] = await Promise.all([
            systemActor(ownerId, "consolidator"),
            systemActor(ownerId, "task_keeper"),
            systemActor(ownerId, "consolidator"),
          ]);
          assert.equal(consolidator.agentId, again.agentId);
          assert.notEqual(consolidator.agentId, keeper.agentId);
          assert.equal(consolidator.agent.systemKey, "consolidator");
          assert.equal(keeper.agent.label, "Task keeper");
          assert.equal(keeper.credential, "system");
          assert.equal(keeper.trustedCreator, false);
          // Owners without a user row (tests, imports) still get an owner agent.
          assert.equal((await ownerActor(outsider)).agent.label, "Owner");
          await assert.rejects(
            resolveActor(outsider, { ownerId, scopes: [], kind: "session" }),
            code("forbidden"),
          );
        },
      );

      await t.test(
        "a legacy token gets one agent on first use, named after the token",
        async () => {
          const { id, principal } = await tokenPrincipal();
          const actors = await Promise.all(
            Array.from({ length: 5 }, () => resolveActor(ownerId, principal)),
          );
          assert.equal(new Set(actors.map((actor) => actor.agentId)).size, 1);
          const [actor] = actors;
          assert.equal(actor.agent.kind, "agent");
          assert.equal(actor.agent.label, "Headless worker");
          assert.equal(actor.agent.labelVerified, false);
          assert.equal(actor.credential, "token");
          assert.equal(actor.tokenId, id);
          assert.equal(actor.claimOnRequest, false);
          assert.equal(actor.trustedCreator, false);
          const bound = await pool.query(
            "SELECT agent_id FROM agent_tokens WHERE id = $1",
            [id],
          );
          assert.equal(bound.rows[0].agent_id, actor.agentId);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::int AS count FROM brain_agents WHERE owner_id = $1 AND label = 'Headless worker'",
                [ownerId],
              )
            ).rows[0].count,
            1,
          );

          // A new token chosen for the same agent keeps the identity.
          const rotated = await createAgentToken(ownerId, {
            name: "Headless worker v2",
            scopes: ["brain:read"],
            agentId: actor.agentId,
          });
          assert.equal(rotated.record.agentId, actor.agentId);
          const rotatedActor = await resolveActor(
            ownerId,
            await principalFromAgentToken(rotated.token),
          );
          assert.equal(rotatedActor.agentId, actor.agentId);

          const owner = await ownerActor(ownerId);
          for (const agentId of [owner.agentId, randomUUID()])
            await assert.rejects(
              createAgentToken(ownerId, {
                name: "Wrong agent",
                scopes: ["brain:read"],
                agentId,
              }),
              code("invalid_input"),
            );
          await assert.rejects(
            createAgentToken(ownerId, {
              name: "Bad agent id",
              scopes: ["brain:read"],
              agentId: "not-a-uuid",
            }),
            code("invalid_input"),
          );

          // Owner policy: trusted_creator applies to token requests only.
          await updateAgent(ownerId, actor.agentId, {
            trustedCreator: true,
            claimOnRequest: true,
          });
          const trusted = await resolveActor(ownerId, principal);
          assert.equal(trusted.trustedCreator, true);
          assert.equal(trusted.claimOnRequest, true);
          await updateAgent(ownerId, actor.agentId, { claimOnRequest: null });
          assert.equal(
            (await resolveActor(ownerId, principal)).claimOnRequest,
            false,
          );
          await assert.rejects(
            resolveActor(ownerId, { ...principal, tokenId: undefined }),
            code("invalid_token"),
          );
        },
      );

      await t.test(
        "an OAuth client is one agent, labelled from its unverified registration",
        async () => {
          const actors = await Promise.all(
            Array.from({ length: 5 }, () => resolveActor(ownerId, oauth())),
          );
          assert.equal(new Set(actors.map((actor) => actor.agentId)).size, 1);
          const [actor] = actors;
          assert.equal(actor.agent.label, "Codex Desktop");
          assert.equal(actor.agent.labelVerified, false);
          assert.equal(actor.clientId, clientId);
          assert.equal(actor.claimOnRequest, true);
          assert.equal(actor.trustedCreator, false);
          const unknown = await resolveActor(ownerId, oauth(`${clientId}-raw`));
          assert.equal(unknown.agent.label, `${clientId}-raw`);
          assert.notEqual(unknown.agentId, actor.agentId);

          await updateAgent(ownerId, actor.agentId, {
            label: "Codex",
            claimOnRequest: false,
            trustedCreator: true,
          });
          const updated = await resolveActor(ownerId, oauth());
          assert.equal(updated.agent.label, "Codex");
          assert.equal(updated.agent.labelVerified, true);
          assert.equal(updated.claimOnRequest, false);
          assert.equal(updated.trustedCreator, false);
          await assert.rejects(
            resolveActor(ownerId, { ...oauth(), clientId: undefined }),
            code("invalid_client"),
          );

          const registry = await listAgents(ownerId);
          assert.equal(registry[0].kind, "owner");
          const listed = registry.find((agent) => agent.id === actor.agentId);
          assert.deepEqual(listed?.clientIds, [clientId]);
          assert.ok(
            registry.some((agent) => agent.activeTokenCount === 2),
            "the rotated token agent counts both active tokens",
          );
        },
      );

      await t.test(
        "last_seen_at and last_used_at are written at most every 5 minutes",
        async () => {
          const { id, raw, principal } = await tokenPrincipal();
          const { agentId } = await resolveActor(ownerId, principal);
          const seen = async () =>
            (
              await pool.query(
                `SELECT a.last_seen_at AS seen, t.last_used_at AS used FROM brain_agents a, agent_tokens t WHERE a.id = $1 AND t.id = $2`,
                [agentId, id],
              )
            ).rows[0];
          const set = (value: string | null) =>
            Promise.all([
              pool.query(
                `UPDATE brain_agents SET last_seen_at = now() + $2::interval WHERE id = $1`,
                [agentId, value],
              ),
              pool.query(
                `UPDATE agent_tokens SET last_used_at = now() + $2::interval WHERE id = $1`,
                [id, value],
              ),
            ]);
          await set("-1 minute");
          const recent = await seen();
          await principalFromAgentToken(raw);
          await resolveActor(ownerId, principal);
          assert.deepEqual(await seen(), recent);
          for (const stale of ["-10 minutes", null]) {
            await set(stale);
            await principalFromAgentToken(raw);
            await resolveActor(ownerId, principal);
            const touched = await seen();
            for (const value of [touched.seen, touched.used])
              assert.ok(Date.now() - new Date(value).getTime() < 60_000);
          }
        },
      );

      await t.test(
        "a disabled agent is refused on its next request; the owner never is",
        async () => {
          const { raw, principal } = await tokenPrincipal();
          const tokenAgent = await resolveActor(ownerId, principal);
          const client = await resolveActor(ownerId, oauth());
          await setAgentDisabled(ownerId, tokenAgent.agentId, true);
          await assert.rejects(
            principalFromAgentToken(raw),
            (error) =>
              code("agent_disabled")(error) &&
              (error as AuthError).status === 403,
          );
          await assert.rejects(
            resolveActor(ownerId, principal),
            code("agent_disabled"),
          );

          await assertOAuthPrincipal(ownerId, clientId);
          await setAgentDisabled(ownerId, client.agentId, true);
          await assert.rejects(
            assertOAuthPrincipal(ownerId, clientId),
            code("agent_disabled"),
          );
          await assert.rejects(
            resolveActor(ownerId, oauth()),
            code("agent_disabled"),
          );
          // Other clients, tokens without a client id, and the owner are unaffected.
          await assertOAuthPrincipal(ownerId, `${clientId}-raw`);
          await assertOAuthPrincipal(ownerId, undefined);
          await assert.rejects(
            assertOAuthPrincipal(outsider, clientId),
            code("forbidden"),
          );

          await setAgentDisabled(ownerId, tokenAgent.agentId, false);
          await setAgentDisabled(ownerId, client.agentId, false);
          assert.equal((await principalFromAgentToken(raw)).ownerId, ownerId);
          await assertOAuthPrincipal(ownerId, clientId);

          const owner = await ownerActor(ownerId);
          await assert.rejects(
            setAgentDisabled(ownerId, owner.agentId, true),
            code("NOT_ALLOWED"),
          );
          const keeper = await systemActor(ownerId, "task_keeper");
          await assert.rejects(
            setAgentDisabled(ownerId, keeper.agentId, true),
            code("NOT_ALLOWED"),
          );
          await assert.rejects(
            setAgentDisabled(ownerId, randomUUID(), true),
            code("AGENT_NOT_FOUND"),
          );
          await assert.rejects(
            setAgentDisabled(outsider, tokenAgent.agentId, true),
            code("AGENT_NOT_FOUND"),
          );
          await assert.rejects(
            pool.query(
              "UPDATE brain_agents SET disabled_at = now() WHERE id = $1",
              [owner.agentId],
            ),
            /brain_agents_owner_state_check/,
          );
          await setAgentDisabled(ownerId, tokenAgent.agentId, true);
          await assert.rejects(
            createAgentToken(ownerId, {
              name: "For a disabled agent",
              scopes: ["brain:read"],
              agentId: tokenAgent.agentId,
            }),
            code("invalid_input"),
          );
          await setAgentDisabled(ownerId, tokenAgent.agentId, false);
        },
      );

      await t.test(
        "owner edits validate kinds, capabilities and person pages",
        async () => {
          const keeper = await systemActor(ownerId, "task_keeper");
          await assert.rejects(
            updateAgent(ownerId, keeper.agentId, { capabilities: ["web"] }),
            code("NOT_ALLOWED"),
          );
          const client = await resolveActor(ownerId, oauth());
          const updated = await updateAgent(ownerId, client.agentId, {
            capabilities: ["repo:agent-brain", "web", "web"],
            createPolicy: "direct",
          });
          assert.deepEqual(updated.capabilities, ["repo:agent-brain", "web"]);
          assert.equal(updated.createPolicy, "direct");
          await assert.rejects(
            updateAgent(ownerId, client.agentId, {
              capabilities: ["has space"],
            }),
            code("INVALID_INPUT"),
          );
          await assert.rejects(
            updateAgent(ownerId, client.agentId, { unknown: true }),
            code("INVALID_INPUT"),
          );
          const note = await brain.write(ownerId, {
            title: "Agents test note",
            type: "note",
            markdown: "Not a person.",
            expectedVersion: 0,
          });
          const person = await brain.write(ownerId, {
            title: "Agents Test Person",
            type: "person",
            markdown: "The owner.",
            expectedVersion: 0,
          });
          const owner = await ownerActor(ownerId);
          await assert.rejects(
            updateAgent(ownerId, owner.agentId, { personPageId: note.id }),
            code("INVALID_PERSON_PAGE"),
          );
          const linked = await updateAgent(ownerId, owner.agentId, {
            personPageId: person.id,
            label: "Tommaso",
          });
          assert.equal(linked.personPageId, person.id);
          assert.equal(linked.label, "Tommaso");
          assert.equal(
            (await updateAgent(ownerId, owner.agentId, { personPageId: null }))
              .personPageId,
            null,
          );
        },
      );

      await t.test(
        "page revisions are signed by the resolved agent",
        async () => {
          const owner = await ownerActor(ownerId);
          const page = await brain.write(
            ownerId,
            {
              title: "Signed decision",
              type: "decision",
              markdown: "Adopt agent-signed revisions.",
              expectedVersion: 0,
            },
            { actorAgentId: owner.agentId },
          );
          assert.deepEqual(await revisionActor(page.id, 1), {
            revision: owner.agentId,
            activity: owner.agentId,
          });
          const client = await resolveActor(ownerId, oauth());
          const appended = await brain.append(
            ownerId,
            {
              ref: page.id,
              expectedVersion: 1,
              markdown: "Recorded by an OAuth agent.",
            },
            { actorAgentId: client.agentId },
          );
          assert.deepEqual(await revisionActor(page.id, appended.version), {
            revision: client.agentId,
            activity: client.agentId,
          });
          // Callers that do not resolve an actor keep writing unsigned revisions.
          const unsigned = await brain.append(ownerId, {
            ref: page.id,
            expectedVersion: appended.version,
            markdown: "Unsigned.",
          });
          assert.deepEqual(await revisionActor(page.id, unsigned.version), {
            revision: null,
            activity: null,
          });

          // REST writes sign with the credential's agent.
          const { raw, principal } = await tokenPrincipal();
          const tokenAgent = await resolveActor(ownerId, principal);
          const created = await pagesPOST(
            new Request("https://brain.example/api/brain/pages", {
              method: "POST",
              headers: { authorization: `Bearer ${raw}` },
              body: JSON.stringify({
                title: "REST signed note",
                type: "note",
                markdown: "Created over REST.",
                expectedVersion: 0,
              }),
            }),
          );
          assert.equal(created.status, 201, await created.clone().text());
          const restPage = (await created.json()).page;
          assert.equal(
            (await revisionActor(restPage.id, 1)).revision,
            tokenAgent.agentId,
          );
          const patched = await pagePATCH(
            new Request(
              `https://brain.example/api/brain/pages/${restPage.id}`,
              {
                method: "PATCH",
                headers: { authorization: `Bearer ${raw}` },
                body: JSON.stringify({
                  title: "REST signed note",
                  type: "note",
                  markdown: "Updated over REST.",
                  expectedVersion: 1,
                }),
              },
            ),
            { params: Promise.resolve({ id: restPage.id }) },
          );
          assert.equal(patched.status, 200, await patched.clone().text());
          assert.equal(
            (await revisionActor(restPage.id, 2)).revision,
            tokenAgent.agentId,
          );

          // A cross-owner actor id cannot sign another owner's revision.
          const foreign = await ownerActor(outsider);
          await assert.rejects(
            brain.write(
              ownerId,
              {
                title: "Foreign signature",
                type: "note",
                markdown: "Rejected.",
                expectedVersion: 0,
              },
              { actorAgentId: foreign.agentId },
            ),
            (error) =>
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "23503",
          );
        },
      );

      await t.test(
        "nightly consolidation signs as the consolidator",
        async () => {
          const page = await brain.write(ownerId, {
            title: "Consolidated note",
            type: "note",
            markdown: "Before the night.",
            expectedVersion: 0,
          });
          const result = await applyConsolidationChangeSet(
            ownerId,
            changeSet([page]),
            `agents-test-${randomUUID()}`,
          );
          assert.equal(result.status, "applied");
          const consolidator = await systemActor(ownerId, "consolidator");
          assert.deepEqual(await revisionActor(page.id, 2), {
            revision: consolidator.agentId,
            activity: consolidator.agentId,
          });
        },
      );
    } finally {
      await pool.query(
        "DELETE FROM brain_pages WHERE owner_id = ANY($1::text[])",
        [[ownerId, outsider]],
      );
      await pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
      await pool.query(`DELETE FROM "oauthClient" WHERE "clientId" = $1`, [
        clientId,
      ]);
      await pool.query(
        "DELETE FROM brain_agents WHERE owner_id = ANY($1::text[])",
        [[ownerId, outsider]],
      );
      if (originalOwner) process.env.BRAIN_OWNER_EMAIL = originalOwner;
      else delete process.env.BRAIN_OWNER_EMAIL;
      await pool.end();
    }
  },
);
