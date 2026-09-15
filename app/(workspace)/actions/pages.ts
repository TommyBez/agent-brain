"use server";

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { read, write } from "@/lib/brain/service";
import { BrainError, type BrainPage } from "@/lib/brain/types";
import { updateWorkspaceCache } from "@/lib/workspace/cache";
import { getWorkspaceUser } from "@/lib/workspace/session";

export interface SavePageState {
  savedPage?: BrainPage;
  message?: string;
  code?: string;
  expectedVersion?: number;
}

const value = (form: FormData, name: string) => {
  const entry = form.get(name);
  return typeof entry === "string" ? entry : "";
};
const list = (input: string) =>
  input
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export async function savePageAction(
  _previous: SavePageState,
  form: FormData,
): Promise<SavePageState> {
  const id = value(form, "id") || undefined;
  const expectedVersion = Number(value(form, "expectedVersion"));
  let savedPage: BrainPage;
  let ownerId: string;
  try {
    const user = await getWorkspaceUser();
    ownerId = user.id;
    savedPage = await write(user.id, {
      ...(id ? { id } : {}),
      expectedVersion,
      title: value(form, "title"),
      type: value(form, "type"),
      summary: value(form, "summary"),
      markdown: value(form, "markdown"),
      aliases: list(value(form, "aliases")),
      tags: list(value(form, "tags")),
      links: JSON.parse(value(form, "links") || "[]"),
      reason:
        value(form, "reason") ||
        (id ? "Edited in workspace" : "Created in workspace"),
      source: "workspace",
    });
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof BrainError) {
      return { message: error.message, code: error.code, expectedVersion };
    }
    if (error instanceof ZodError) {
      return {
        message: error.issues.map((issue) => issue.message).join(" "),
        code: "INVALID_INPUT",
      };
    }
    if (error instanceof SyntaxError) {
      return {
        message:
          "The page connections could not be read. Please review them and try again.",
        code: "INVALID_INPUT",
      };
    }
    console.error(
      "Page save failed",
      error instanceof Error ? error.name : "unknown error",
    );
    return {
      message:
        "Unable to save this page. Your draft is preserved. Please try again.",
      code: "SAVE_FAILED",
    };
  }
  updateWorkspaceCache(ownerId);
  return { savedPage };
}

export async function readLatestPageAction(id: string) {
  const user = await getWorkspaceUser();
  // Conflict reconciliation must compare against the committed version, not a cached reader.
  return read(user.id, { ref: id });
}
