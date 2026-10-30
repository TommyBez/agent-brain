import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createAgentToken } from "../lib/agent-tokens";
import {
  AuthError,
  type Principal,
  principalFromAgentToken,
} from "../lib/auth-principal";
import * as brain from "../lib/brain/service";
import { BrainError } from "../lib/brain/types";
import { getPool } from "../lib/db";
import { ownerActor, resolveActor, systemActor } from "../lib/tasks/actors";
import { claimTask } from "../lib/tasks/claims";
import { createTask } from "../lib/tasks/service";
import {
  agentRegistry,
  revisionActors,
  setRegistryAgentDisabled,
  tokenAgentChoices,
  updateRegistryAgent,
} from "../lib/workspace/agent-registry";

const code = (expected: string) => (error: unknown) =>
  (error instanceof BrainError || error instanceof AuthError) &&
  error.code === expected;

test(
  "agent registry: owner edits, token-only trusted creators, disable and claims",
  { skip: process.env.RUN_DB_TESTS !== "1", timeout: 120_000 },
  async (t) => {
    const pool = getPool();
    const ownerId = randomUUID();
    const email = `agent-registry-${ownerId}@example.invalid`;
    const suffix = ownerId.slice(0, 8);
    const savedOwner = process.env.BRAIN_OWNER_EMAIL;
    const savedEmbeddings = process.env.BRAIN_QUERY_EMBEDDINGS;
    process.env.BRAIN_OWNER_EMAIL = [savedOwner, email]
      .filter(Boolean)
      .join(",");
    process.env.BRAIN_QUERY_EMBEDDINGS = "false";
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,'Registry Owner',$2,true,now(),now())`,
      [ownerId, email],
    );
    const scopes = ["brain:read", "brain:write"];
    const oauth: Principal = {
      ownerId,
      scopes,
      kind: "oauth",
      clientId: `registry-client-${suffix}`,
    };
    try {
      const owner = await ownerActor(ownerId);
      const consolidator = await systemActor(ownerId, "consolidator");
      const claude = await resolveActor(ownerId, oauth);
      const tokenPrincipal = await principalFromAgentToken(
        (await createAgentToken(ownerId, { name: "Nightly worker", scopes }))
          .token,
      );
      const worker = await resolveActor(ownerId, tokenPrincipal);
      const byId = async (id: string) => {
        const entry = (await agentRegistry(ownerId)).find(
          (agent) => agent.id === id,
        );
        assert.ok(entry);
        return entry;
      };

      await t.test(
        "the registry lists every agent with its credentials",
        async () => {
          const agents = await agentRegistry(ownerId);
          assert.deepEqual(
            agents.map((agent) => agent.kind),
            ["owner", "agent", "agent", "system"],
          );
          const tokenAgent = await byId(worker.agentId);
          assert.equal(tokenAgent.label, "Nightly worker");
          assert.equal(tokenAgent.labelVerified, false);
          assert.deepEqual(
            tokenAgent.tokens.map((token) => [token.name, token.active]),
            [["Nightly worker", true]],
          );
          assert.equal(tokenAgent.canBeTrustedCreator, true);
          const oauthAgent = await byId(claude.agentId);
          assert.deepEqual(oauthAgent.clientIds, [oauth.clientId]);
          assert.equal(oauthAgent.canBeTrustedCreator, false);
          assert.equal((await byId(owner.agentId)).canBeTrustedCreator, false);
          assert.equal(
            (await byId(consolidator.agentId)).canBeTrustedCreator,
            false,
          );
          assert.deepEqual(
            tokenAgentChoices(agents)
              .map((choice) => choice.id)
              .sort(),
            [claude.agentId, worker.agentId].sort(),
          );
        },
      );

      await t.test("owner edits reach the next request's actor", async () => {
        const saved = await updateRegistryAgent(ownerId, worker.agentId, {
          label: "Headless worker",
          capabilities: ["repo:agent-brain", "web", "web"],
          createPolicy: "direct",
          trustedCreator: true,
          claimOnRequest: true,
        });
        assert.equal(saved.labelVerified, true);
        assert.deepEqual(saved.capabilities, ["repo:agent-brain", "web"]);
        let actor = await resolveActor(ownerId, tokenPrincipal);
        assert.equal(actor.agent.label, "Headless worker");
        assert.equal(actor.agent.createPolicy, "direct");
        assert.equal(actor.trustedCreator, true);
        assert.equal(actor.claimOnRequest, true);
        await updateRegistryAgent(ownerId, worker.agentId, {
          claimOnRequest: null,
        });
        actor = await resolveActor(ownerId, tokenPrincipal);
        assert.equal(actor.claimOnRequest, false, "Token default is off");

        await updateRegistryAgent(ownerId, claude.agentId, {
          claimOnRequest: false,
        });
        assert.equal(
          (await resolveActor(ownerId, oauth)).claimOnRequest,
          false,
        );
        await updateRegistryAgent(ownerId, claude.agentId, {
          claimOnRequest: null,
        });
        assert.equal(
          (await resolveActor(ownerId, oauth)).claimOnRequest,
          true,
          "OAuth default is on",
        );
        await updateRegistryAgent(ownerId, owner.agentId, {
          label: "Tommaso",
        });
        assert.equal((await ownerActor(ownerId)).agent.label, "Tommaso");
      });

      await t.test(
        "trusted creator is refused for agents without a token",
        async () => {
          await assert.rejects(
            updateRegistryAgent(ownerId, claude.agentId, {
              trustedCreator: true,
            }),
            code("NOT_ALLOWED"),
          );
          assert.equal((await byId(claude.agentId)).trustedCreator, false);
          await updateRegistryAgent(ownerId, claude.agentId, {
            trustedCreator: false,
          });
          await assert.rejects(
            updateRegistryAgent(ownerId, consolidator.agentId, {
              createPolicy: "direct",
            }),
            code("NOT_ALLOWED"),
          );
          await assert.rejects(
            updateRegistryAgent(ownerId, "not-an-id", { label: "x" }),
            code("AGENT_NOT_FOUND"),
          );
          await assert.rejects(
            updateRegistryAgent(ownerId, randomUUID(), {
              trustedCreator: true,
            }),
            code("NOT_ALLOWED"),
          );
          await assert.rejects(
            updateRegistryAgent(ownerId, worker.agentId, {
              capabilities: ["bad capability"],
            }),
            code("INVALID_INPUT"),
          );
          await assert.rejects(
            updateRegistryAgent(ownerId, worker.agentId, {
              unknown: true,
            } as never),
            code("INVALID_INPUT"),
          );
        },
      );

      await t.test(
        "disable refuses the next request; enable restores it",
        async () => {
          await setRegistryAgentDisabled(ownerId, claude.agentId, true);
          await assert.rejects(
            resolveActor(ownerId, oauth),
            code("agent_disabled"),
          );
          const agents = await agentRegistry(ownerId);
          assert.ok(
            agents.find((agent) => agent.id === claude.agentId)?.disabledAt,
          );
          assert.deepEqual(
            tokenAgentChoices(agents).map((choice) => choice.id),
            [worker.agentId],
          );
          await setRegistryAgentDisabled(ownerId, claude.agentId, false);
          assert.equal(
            (await resolveActor(ownerId, oauth)).agentId,
            claude.agentId,
          );
          for (const id of [owner.agentId, consolidator.agentId])
            await assert.rejects(
              setRegistryAgentDisabled(ownerId, id, true),
              code("NOT_ALLOWED"),
            );
        },
      );

      await t.test(
        "claims in progress and expired leases per agent",
        async () => {
          const first = await createTask(owner, { title: `Claimed ${suffix}` });
          const second = await createTask(owner, {
            title: `Expired ${suffix}`,
          });
          const agent = await resolveActor(ownerId, oauth);
          await claimTask(agent, { ref: first.task.ref });
          await claimTask(agent, { ref: second.task.ref });
          await pool.query(
            "UPDATE brain_tasks SET lease_expires_at = now() - interval '1 minute' WHERE owner_id = $1 AND id = $2",
            [ownerId, second.task.id],
          );
          const entry = await byId(claude.agentId);
          assert.deepEqual(entry.claims, [first.task.ref]);
          assert.deepEqual(entry.expiredClaims, [second.task.ref]);
          assert.deepEqual((await byId(worker.agentId)).claims, []);
        },
      );

      await t.test("revision history names the signing agent", async () => {
        const page = await brain.write(
          ownerId,
          {
            title: `Signed page ${suffix}`,
            type: "note",
            markdown: "First.",
            expectedVersion: 0,
          },
          { actorAgentId: owner.agentId },
        );
        await brain.write(
          ownerId,
          {
            id: page.id,
            title: page.title,
            type: "note",
            markdown: "Second.",
            expectedVersion: 1,
          },
          { actorAgentId: worker.agentId },
        );
        await brain.write(ownerId, {
          id: page.id,
          title: page.title,
          type: "note",
          markdown: "Third, unsigned.",
          expectedVersion: 2,
        });
        assert.deepEqual(
          await revisionActors(ownerId, page.id, { limit: 51, offset: 0 }),
          {
            1: { label: "Tommaso", kind: "owner" },
            2: { label: "Headless worker", kind: "agent" },
          },
        );
        assert.deepEqual(
          await revisionActors(ownerId, page.slug, { limit: 1, offset: 1 }),
          { 2: { label: "Headless worker", kind: "agent" } },
          "Unsigned revisions keep the window aligned with the history list",
        );
        assert.deepEqual(
          await revisionActors(ownerId, page.id, { version: 1 }),
          { 1: { label: "Tommaso", kind: "owner" } },
        );
        assert.deepEqual(
          await revisionActors(randomUUID(), page.id, { version: 1 }),
          {},
        );
      });
    } finally {
      if (savedOwner) process.env.BRAIN_OWNER_EMAIL = savedOwner;
      else delete process.env.BRAIN_OWNER_EMAIL;
      if (savedEmbeddings) process.env.BRAIN_QUERY_EMBEDDINGS = savedEmbeddings;
      else delete process.env.BRAIN_QUERY_EMBEDDINGS;
      for (const table of [
        "brain_task_events",
        "brain_tasks",
        "brain_pages",
        "agent_tokens",
        "brain_agent_clients",
      ])
        await pool.query(`DELETE FROM ${table} WHERE owner_id = $1`, [ownerId]);
      await pool.query('DELETE FROM "user" WHERE id = $1', [ownerId]);
      await pool.query("DELETE FROM brain_agents WHERE owner_id = $1", [
        ownerId,
      ]);
      await pool.end();
    }
  },
);
