export function configuredAppOrigin(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  let name = "BETTER_AUTH_URL";
  let value = env.BETTER_AUTH_URL;
  if (env.VERCEL_ENV === "production") {
    name = "VERCEL_PROJECT_PRODUCTION_URL";
    value = env.VERCEL_PROJECT_PRODUCTION_URL;
  } else if (env.VERCEL_ENV === "preview") {
    name = "VERCEL_URL";
    value = env.VERCEL_URL;
  }
  if (!value) return undefined;
  const systemDomain = name !== "BETTER_AUTH_URL";
  const url = new URL(systemDomain ? `https://${value}` : value);
  if (
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password ||
    (systemDomain && value !== url.host)
  ) {
    throw new Error(
      `${name} must identify an application origin, without a path.`,
    );
  }
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  ) {
    throw new Error(`${name} must use HTTPS (except localhost).`);
  }
  return url.origin;
}
