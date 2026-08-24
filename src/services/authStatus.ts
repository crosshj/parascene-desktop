/**
 * Soft Parascene session status via service_invoke (Result handle).
 */
import { serviceInvoke } from "./serviceClient";

export type AuthStatus = {
  status: "signed_out" | "connected" | string;
  configured: boolean;
  userId?: string | null;
};

export async function getAuthStatus(): Promise<AuthStatus> {
  const handle = await serviceInvoke({
    service: "auth",
    operation: "status",
    payload: {},
  });
  if (handle.mode !== "result") {
    throw new Error("auth.status expected a sync result handle");
  }
  const data = handle.data as AuthStatus | null;
  if (!data || typeof data !== "object") {
    throw new Error("auth.status returned no data");
  }
  return {
    status: typeof data.status === "string" ? data.status : "signed_out",
    configured: data.configured === true,
    userId:
      typeof data.userId === "string" && data.userId.trim()
        ? data.userId.trim()
        : null,
  };
}
