const API_URL = import.meta.env.VITE_API_URL || "";

export async function api(path, { token, ...options } = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !(options.body instanceof FormData)) headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${API_URL}/api${path}`, { ...options, headers });
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && token) window.dispatchEvent(new Event("auth-expired"));
    throw new Error(body.error || `Request failed (${response.status}).`);
  }
  return body;
}

export function jsonBody(value) {
  return JSON.stringify(value);
}
