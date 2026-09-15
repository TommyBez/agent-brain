export const WORKSPACE_PATH_HEADER = "x-brain-workspace-path";

// A post-login destination is an application path, never a provider callback.
// OAuth redirects are returned by Better Auth after it validates the signed flow.
export function safeReturnTo(value: string | null | undefined): string {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject URL parser control-character normalization.
    /[\\\u0000-\u001f\u007f]/u.test(value)
  )
    return "/";
  try {
    const url = new URL(value, "https://brain.invalid");
    if (
      url.origin !== "https://brain.invalid" ||
      url.pathname.startsWith("//") ||
      /^\/(?:sign-in|api|mcp|_next)(?:\/|$)/.test(url.pathname) ||
      /%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(url.pathname)
    )
      return "/";
    // Flight request markers are transport state, not part of the user's URL.
    url.searchParams.delete("_rsc");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}

export function signInHref(destination: string | null | undefined) {
  const returnTo = safeReturnTo(destination);
  return returnTo === "/"
    ? "/sign-in"
    : `/sign-in?${new URLSearchParams({ returnTo })}`;
}
