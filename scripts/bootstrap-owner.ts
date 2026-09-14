import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hashPassword } from "better-auth/crypto";
import { getPool, transaction } from "../lib/db";

try {
  process.loadEnvFile(".env.local");
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

async function hiddenPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY)
    throw new Error(
      "Set BRAIN_OWNER_PASSWORD or BRAIN_OWNER_PASSWORD_FILE, or run interactively to choose a password.",
    );
  process.stdout.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let password = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          finish();
          reject(new Error("Cancelled."));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          resolve(password);
          return;
        }
        if (char === "\u007f" || char === "\b")
          password = password.slice(0, -1);
        else if (char.charCodeAt(0) >= 32) password += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function main() {
  const email = process.env.BRAIN_OWNER_EMAIL?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    throw new Error("Set BRAIN_OWNER_EMAIL to the owner's email first.");
  let password = process.env.BRAIN_OWNER_PASSWORD;
  if (!password && process.env.BRAIN_OWNER_PASSWORD_FILE)
    password = (
      await readFile(process.env.BRAIN_OWNER_PASSWORD_FILE, "utf8")
    ).trimEnd();
  if (!password) {
    password = await hiddenPassword(
      "Choose owner password (12+ characters; input hidden): ",
    );
    if (password !== (await hiddenPassword("Repeat password: ")))
      throw new Error("Passwords do not match.");
  }
  if (password.length < 12 || password.length > 128)
    throw new Error("Choose a password between 12 and 128 characters.");
  const hashed = await hashPassword(password);
  await transaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext('agent-brain-owner-bootstrap'))",
    );
    const existing = await client.query('SELECT id FROM "user" LIMIT 1');
    if (existing.rows.length)
      throw new Error(
        "An owner already exists. Bootstrap never resets an existing password. Use the signed-in change-password flow.",
      );
    const id = randomUUID();
    await client.query(
      'INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,true,now(),now())',
      [id, process.env.BRAIN_OWNER_NAME || "Tommaso", email],
    );
    await client.query(
      'INSERT INTO "account" (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2,\'credential\',$2,$3,now(),now())',
      [randomUUID(), id, hashed],
    );
  });
  console.log(
    "Owner created. Sign in with the chosen password. Public registration remains disabled.",
  );
}

main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Owner bootstrap failed.",
    );
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
