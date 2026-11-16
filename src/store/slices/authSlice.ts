import { createAsyncThunk, createSlice, PayloadAction } from "@reduxjs/toolkit";
import { authService, AuthSession, LoginResult } from "../../services/authService";
import { Role, User } from "../../types";

interface AuthState {
  user: User | null;
  challengeToken: string | null;
  status: "idle" | "loading" | "error";
  error: string | null;
}

interface Credentials {
  email: string;
  password: string;
}

interface RegistrationDetails extends Credentials {
  name: string;
  role: Exclude<Role, "admin">;
}

function loadStoredUser(): User | null {
  if (!localStorage.getItem("edugen-token")) {
    localStorage.removeItem("edugen-user");
    return null;
  }
  const storedUser = localStorage.getItem("edugen-user");
  if (!storedUser) return null;

  try {
    const value: unknown = JSON.parse(storedUser);
    if (
      typeof value !== "object" ||
      value === null ||
      !("id" in value) ||
      !("name" in value) ||
      !("email" in value) ||
      !("role" in value) ||
      typeof value.name !== "string" ||
      typeof value.email !== "string" ||
      (value.role !== "student" && value.role !== "teacher" && value.role !== "admin")
    ) {
      throw new Error("Stored user data is invalid.");
    }

    return {
      id: String(value.id),
      name: value.name,
      email: value.email,
      role: value.role,
      totpEnabled: "totpEnabled" in value && value.totpEnabled === true,
      department:
        "department" in value && typeof value.department === "string"
          ? value.department
          : "",
      ...("avatar" in value && typeof value.avatar === "string"
        ? { avatar: value.avatar }
        : {}),
    };
  } catch (error) {
    console.error("Unable to restore the saved EduGen user.", error);
    localStorage.removeItem("edugen-user");
    localStorage.removeItem("edugen-token");
    return null;
  }
}

const initialState: AuthState = {
  user: loadStoredUser(),
  challengeToken: null,
  status: "idle",
  error: null,
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Authentication request failed.";
}

function persistSession(session: AuthSession, state: AuthState) {
  state.user = session.user;
  localStorage.setItem("edugen-user", JSON.stringify(session.user));
  localStorage.setItem("edugen-token", session.token);
}

export const loginWithEmail = createAsyncThunk<
  LoginResult,
  Credentials,
  { rejectValue: string }
>("auth/login", async (credentials, { rejectWithValue }) => {
  try {
    return await authService.login(credentials);
  } catch (error) {
    return rejectWithValue(getErrorMessage(error));
  }
});

export const registerWithEmail = createAsyncThunk<
  AuthSession,
  RegistrationDetails,
  { rejectValue: string }
>("auth/register", async (details, { rejectWithValue }) => {
  try {
    return await authService.register(details);
  } catch (error) {
    return rejectWithValue(getErrorMessage(error));
  }
});

export const verifyTotpLogin = createAsyncThunk<AuthSession, { challengeToken: string; code: string }, { rejectValue: string }>(
  "auth/verifyTotpLogin",
  async (details, { rejectWithValue }) => {
    try { return await authService.verifyTotpLogin(details.challengeToken, details.code); }
    catch (error) { return rejectWithValue(getErrorMessage(error)); }
  },
);

const authSlice = createSlice({
  name: "auth",
  initialState,
  reducers: {
    logout(state) {
      state.user = null;
      state.challengeToken = null;
      state.status = "idle";
      state.error = null;
      localStorage.removeItem("edugen-user");
      localStorage.removeItem("edugen-token");
    },
    setUser(state, action: PayloadAction<User>) {
      state.user = action.payload;
      localStorage.setItem("edugen-user", JSON.stringify(action.payload));
    },
    setTotpEnabled(state, action: PayloadAction<boolean>) {
      if (!state.user) return;
      state.user.totpEnabled = action.payload;
      localStorage.setItem("edugen-user", JSON.stringify(state.user));
    },
    clearMfaChallenge(state) {
      state.challengeToken = null;
    },
    clearAuthError(state) {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(loginWithEmail.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(loginWithEmail.fulfilled, (state, action) => {
        state.status = "idle";
        if ("mfaRequired" in action.payload) {
          state.challengeToken = action.payload.challengeToken;
        } else {
          state.challengeToken = null;
          persistSession(action.payload, state);
        }
      })
      .addCase(loginWithEmail.rejected, (state, action) => {
        state.status = "error";
        state.error = action.payload ?? action.error.message ?? "Login failed.";
      })
      .addCase(registerWithEmail.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(registerWithEmail.fulfilled, (state, action) => {
        state.status = "idle";
        persistSession(action.payload, state);
      })
      .addCase(registerWithEmail.rejected, (state, action) => {
        state.status = "error";
        state.error = action.payload ?? action.error.message ?? "Registration failed.";
      })
      .addCase(verifyTotpLogin.pending, (state) => {
        state.status = "loading";
        state.error = null;
      })
      .addCase(verifyTotpLogin.fulfilled, (state, action) => {
        state.status = "idle";
        state.challengeToken = null;
        persistSession(action.payload, state);
      })
      .addCase(verifyTotpLogin.rejected, (state, action) => {
        state.status = "error";
        state.error = action.payload ?? action.error.message ?? "Verification failed.";
      });
  },
});

export const { logout, setUser, setTotpEnabled, clearMfaChallenge, clearAuthError } = authSlice.actions;
export default authSlice.reducer;
