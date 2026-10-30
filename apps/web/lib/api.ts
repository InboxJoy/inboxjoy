import { clearWorkspaceId, getWorkspaceId } from "./workspaces";

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "/api";

type ApiErrorBody = { code?: unknown; error?: unknown; message?: unknown; field?: unknown; details?: unknown };
const WORKSPACE_RELOAD_KEY = "inboxjoy.workspace-reload";
let workspaceReloadScheduled = false;

export function workspaceRequestHeaders(initialHeaders?: HeadersInit): Headers {
  const headers = new Headers(initialHeaders);
  const workspaceId = getWorkspaceId();
  if (workspaceId) headers.set("x-workspace-id", workspaceId);
  else headers.delete("x-workspace-id");
  return headers;
}

function clearWorkspaceReloadFlag(): void {
  try {
    window.sessionStorage.removeItem(WORKSPACE_RELOAD_KEY);
  } catch {}
}

function reloadChangedWorkspace(): void {
  clearWorkspaceId();
  if (workspaceReloadScheduled || typeof window === "undefined") return;
  try {
    if (window.sessionStorage.getItem(WORKSPACE_RELOAD_KEY) === "1") return;
    window.sessionStorage.setItem(WORKSPACE_RELOAD_KEY, "1");
  } catch {}
  workspaceReloadScheduled = true;
  window.location.reload();
}

export class ApiError extends Error {
  code?: string;
  field?: string;
  details?: unknown;
  status: number;

  constructor(message: string, status: number, code?: string, field?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
    this.details = details;
  }
}

function apiUrl(path: string) {
  if (/^https?:\/\//.test(path) || path.startsWith(API_BASE_URL)) return path;
  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

function serverMessage(data: unknown) {
  if (!data || typeof data !== "object") return "";
  const body = data as ApiErrorBody;
  const message = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : "";
  if (!message || /syntaxerror|unexpected token|json parse|invalid json|payload too large|body limit/i.test(message)) return "";
  return message;
}

function statusMessage(status: number, fallback: string) {
  if (status === 401) return "Your session has expired. Sign in again and retry.";
  if (status === 403) return "You do not have permission to complete this action.";
  if (status === 413) return "That CSV is too large. Choose a file smaller than 6 MB and try again.";
  if (status >= 500) return "InboxJoy is temporarily unavailable. Please try again in a moment.";
  return fallback;
}

export function apiErrorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export function isEmailUnverifiedError(reason: unknown) {
  return reason instanceof ApiError && reason.status === 403 && reason.code === "email_unverified";
}

export async function apiFetch<T>(path: string, init: RequestInit = {}, fallbackMessage = "Something went wrong. Please try again."): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), { ...init, headers: workspaceRequestHeaders(init.headers), credentials: "include" });
  } catch {
    throw new ApiError("Could not reach InboxJoy. Check your connection and try again.", 0);
  }

  if (response.ok) clearWorkspaceReloadFlag();
  if (response.status === 204) return undefined as T;

  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError("InboxJoy returned an incomplete response. Please try again.", response.status);
  }
  let data: unknown = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(response.ok ? "InboxJoy returned an unexpected response. Please try again." : statusMessage(response.status, fallbackMessage), response.status);
    }
  }

  if (!response.ok) {
    const rawCode = data && typeof data === "object" ? (data as ApiErrorBody).code : undefined;
    const code = typeof rawCode === "string" ? rawCode : undefined;
    const rawField = data && typeof data === "object" ? (data as ApiErrorBody).field : undefined;
    const field = response.status === 400 && typeof rawField === "string" ? rawField : undefined;
    if (response.status === 409 && code === "workspace_changed") reloadChangedWorkspace();
    const details = data && typeof data === "object" ? (data as ApiErrorBody).details : undefined;
    throw new ApiError(serverMessage(data) || statusMessage(response.status, fallbackMessage), response.status, code, field, details);
  }

  return data as T;
}
