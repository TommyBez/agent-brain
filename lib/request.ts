export async function request<T>(
  url: string,
  options?: RequestInit,
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  const data = await response.json();
  if (!response.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : (data.error?.message ??
          data.message ??
          "The request could not be completed.");
    const error = new Error(message) as Error & {
      status: number;
      code?: string;
      details?: unknown;
    };
    error.status = response.status;
    error.code = data.code;
    error.details = data.details;
    throw error;
  }
  return data as T;
}
