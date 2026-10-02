const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REPOSITORY = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;

export function exportRepositories(
  source = process.env.BRAIN_EXPORT_REPOSITORIES,
) {
  const repositories = new Map<string, string>();
  for (const part of (source ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const separator = entry.indexOf("=");
    const email =
      separator === -1 ? "" : entry.slice(0, separator).trim().toLowerCase();
    const repository =
      separator === -1 ? "" : entry.slice(separator + 1).trim();
    if (!EMAIL_ADDRESS.test(email) || !REPOSITORY.test(repository))
      throw new Error(
        `BRAIN_EXPORT_REPOSITORIES contains an invalid entry: ${entry}`,
      );
    if (repositories.has(email))
      throw new Error(
        `BRAIN_EXPORT_REPOSITORIES lists ${email} more than once.`,
      );
    repositories.set(email, repository);
  }
  return repositories;
}

export function exportRepositoryForEmail(email: string) {
  return exportRepositories().get(email.trim().toLowerCase());
}
