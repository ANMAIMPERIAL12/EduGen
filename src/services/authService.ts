import axios from "axios";
import axiosClient from "../api/axiosClient";
import { Role, User } from "../types";

interface AuthCredentials {
  email: string;
  password: string;
}

interface RegisterDetails extends AuthCredentials {
  name: string;
  role: Exclude<Role, "admin">;
}

interface AuthResponse {
  token: string;
  user: {
    id: string | number;
    name: string;
    email: string;
    role: Role;
    department?: string | null;
    totpEnabled?: boolean;
  };
}

interface LoginChallenge {
  mfaRequired: true;
  challengeToken: string;
}

export type LoginResult = AuthSession | LoginChallenge;

export interface AuthSession {
  token: string;
  user: User;
}

function toUser(response: AuthResponse["user"]): User {
  return {
    ...response,
    id: String(response.id),
    department: response.department ?? "",
    totpEnabled: Boolean(response.totpEnabled),
  };
}

function getApiErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const responseData = error.response?.data;
    const responseError =
      typeof responseData === "object" &&
      responseData !== null &&
      "error" in responseData
        ? responseData.error
        : undefined;
    if (typeof responseError === "string" && responseError.trim()) {
      return responseError;
    }

    if (!error.response) {
      return "Unable to connect to the server. Check your connection and try again.";
    }
  }

  return error instanceof Error ? error.message : "The request failed.";
}

async function requestAuth(
  endpoint: "/auth/login" | "/auth/register",
  credentials: AuthCredentials | RegisterDetails,
): Promise<LoginResult> {
  try {
    const response = await axiosClient.post<AuthResponse | LoginChallenge>(endpoint, credentials);
    if ("mfaRequired" in response.data && response.data.mfaRequired) return response.data;
    return {
      token: (response.data as AuthResponse & { token: string }).token,
      user: toUser((response.data as AuthResponse).user),
    };
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
}

export const authService = {
  login(credentials: AuthCredentials): Promise<LoginResult> {
    return requestAuth("/auth/login", credentials);
  },
  async register(details: RegisterDetails): Promise<AuthSession> {
    const result = await requestAuth("/auth/register", details);
    if ("mfaRequired" in result) throw new Error("Unexpected authentication challenge.");
    return result;
  },
  async verifyTotpLogin(challengeToken: string, code: string): Promise<AuthSession> {
    try {
      const response = await axiosClient.post<AuthResponse & { token: string }>(
        "/auth/totp/verify-login", { challengeToken, code },
      );
      return { token: response.data.token, user: toUser(response.data.user) };
    } catch (error) {
      throw new Error(getApiErrorMessage(error));
    }
  },
  async setupTotp(): Promise<string> {
    try {
      const response = await axiosClient.post<{ qrCode: string }>("/auth/totp/setup");
      return response.data.qrCode;
    } catch (error) {
      throw new Error(getApiErrorMessage(error));
    }
  },
  async enableTotp(code: string): Promise<string[]> {
    try {
      const response = await axiosClient.post<{ recoveryCodes: string[] }>("/auth/totp/enable", { code });
      return response.data.recoveryCodes;
    } catch (error) {
      throw new Error(getApiErrorMessage(error));
    }
  },
};

export async function requestPasswordReset(email: string): Promise<string> {
  try {
    const response = await axiosClient.post<{ message: string }>("/auth/forgot-password", { email });
    return response.data.message;
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
}

export async function submitPasswordReset(token: string, password: string): Promise<string> {
  try {
    const response = await axiosClient.post<{ message: string }>("/auth/reset-password", { token, password });
    return response.data.message;
  } catch (error) {
    throw new Error(getApiErrorMessage(error));
  }
}
