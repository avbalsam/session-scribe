import { API_BASE_URL } from "./config";

export function apiFetch(path: string, options: RequestInit = {}) {
  return fetch(`${API_BASE_URL}${path}`, {
    ...options,
    credentials: "include",
  });
}
