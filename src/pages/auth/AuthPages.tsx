import { FormEvent, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../components/ui/Button";
import { Card } from "../../components/ui/Card";
import { Input, Label, Select } from "../../components/ui/Input";
import { useAppDispatch, useAppSelector } from "../../store/hooks";
import {
  clearAuthError,
  clearMfaChallenge,
  loginWithEmail,
  registerWithEmail,
  verifyTotpLogin,
} from "../../store/slices/authSlice";
import { requestPasswordReset, submitPasswordReset } from "../../services/authService";
import { Role } from "../../types";

function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-h-screen bg-slate-50 text-slate-950 dark:bg-slate-950 dark:text-white lg:grid-cols-[0.9fr_1.1fr]">
      <aside className="hidden bg-slate-900 p-10 text-white lg:flex lg:flex-col lg:justify-between">
        <Link to="/" className="flex items-center gap-3 font-bold">
          <span className="grid h-10 w-10 place-items-center rounded-md bg-brand-600">
            E
          </span>
          EduGen AI
        </Link>
        <div>
          <h1 className="text-4xl font-bold tracking-normal">
            Personalized learning powered by Artificial Intelligence.
          </h1>
          <p className="mt-4 text-slate-300">
            AI tutoring, analytics, study planning and role-based learning
            management in one polished demo.
          </p>
        </div>
      </aside>
      <main className="flex items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {subtitle}
          </p>
          {children}
        </Card>
      </main>
    </div>
  );
}

export function LoginPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useAppSelector((state) => state.auth.user);
  const { error, status } = useAppSelector((state) => state.auth);
  const loading = status === "loading";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  if (user) return <Navigate to={`/${user.role}/dashboard`} replace />;

  async function login(event: FormEvent) {
    event.preventDefault();
    const action = await dispatch(loginWithEmail({ email, password }));
    if (loginWithEmail.fulfilled.match(action)) {
      if ("mfaRequired" in action.payload) {
        navigate("/two-factor");
      } else {
        navigate(`/${action.payload.user.role}/dashboard`);
      }
    }
  }

  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to continue to your EduGen AI workspace."
    >
      <form className="mt-6 space-y-4" onSubmit={login}>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div className="flex items-center justify-between text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="h-4 w-4 rounded" /> Remember me
          </label>
          <Link to="/forgot-password" className="text-brand-600">
            Forgot password?
          </Link>
        </div>
        <Button className="w-full" disabled={loading}>
          {loading ? "Signing in..." : "Login"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </p>
      )}
      <p className="mt-5 text-center text-sm text-slate-500">
        New here?{" "}
        <Link className="text-brand-600" to="/register">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}

export function TwoFactorVerifyPage() {
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const { status, error, challengeToken } = useAppSelector((state) => state.auth);
  const [code, setCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  if (!challengeToken) return <Navigate to="/login" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    const result = await dispatch(verifyTotpLogin({ challengeToken: challengeToken!, code }));
    if (verifyTotpLogin.fulfilled.match(result)) {
      navigate(`/${result.payload.user.role}/dashboard`, { replace: true });
    }
  }

  return (
    <AuthShell title="Two-Factor Authentication" subtitle="Enter the six-digit code from Google Authenticator.">
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div>
          <Label htmlFor="totp-code">{useRecoveryCode ? "Recovery code" : "Authentication code"}</Label>
          <Input id="totp-code" type="text" inputMode={useRecoveryCode ? "text" : "numeric"} autoComplete={useRecoveryCode ? "off" : "one-time-code"}
            pattern={useRecoveryCode ? "[A-Fa-f0-9]{4}(-[A-Fa-f0-9]{4}){5}" : "[0-9]{6}"} maxLength={useRecoveryCode ? 29 : 6} value={code}
            onChange={(event) => setCode(useRecoveryCode
              ? event.target.value.replace(/[^a-f\d]/gi, "").slice(0, 16).toUpperCase().replace(/(.{4})(?=.)/g, "$1-")
              : event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder={useRecoveryCode ? "0000-0000-0000-0000-0000-0000" : "000000"} required />
        </div>
        <Button className="w-full" disabled={status === "loading" || (useRecoveryCode ? code.length !== 29 : code.length !== 6)}>
          {status === "loading" ? "Verifying..." : "Verify"}
        </Button>
      </form>
      {error && <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>}
      <button type="button" className="mt-4 text-sm text-brand-600" onClick={() => { setUseRecoveryCode(!useRecoveryCode); setCode(""); }}>
        {useRecoveryCode ? "Use an authenticator code" : "Use a recovery code"}
      </button>
      <p className="mt-5 text-center text-sm"><Link className="text-brand-600" to="/login" onClick={() => dispatch(clearMfaChallenge())}>Return to login</Link></p>
    </AuthShell>
  );
}


export function RegisterPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const { error: authError, status } = useAppSelector((state) => state.auth);

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [role, setRole] = useState<"student" | "teacher">("student");
  const [validationError, setValidationError] = useState("");
  const loading = status === "loading";

  async function handleRegister(event: FormEvent) {
    event.preventDefault();
    setValidationError("");
    dispatch(clearAuthError());

    if (password.length < 8) {
      setValidationError("Password must contain at least 8 characters.");
      return;
    }

    if (password !== confirmPassword) {
      setValidationError("Passwords do not match.");
      return;
    }

    const action = await dispatch(registerWithEmail({ name, email, password, role }));
    if (registerWithEmail.fulfilled.match(action)) {
      navigate(`/${action.payload.user.role}/dashboard`);
    }
  }

  return (
    <AuthShell
      title="Create account"
      subtitle="Create your EduGen AI account."
    >
      <form className="mt-6 space-y-4" onSubmit={handleRegister}>
        <div>
          <Label>Full name</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your full name"
            required
          />
        </div>

        <div>
          <Label>Email</Label>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
            required
          />
        </div>

        <div>
          <Label>Password</Label>
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <div>
          <Label>Confirm password</Label>
          <Input
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
          />
        </div>

        <div>
          <Label>Role</Label>
          <Select
            value={role}
            onChange={(e) =>
              setRole(e.target.value as "student" | "teacher")
            }
          >
            <option value="student">Student</option>
            <option value="teacher">Teacher</option>
          </Select>
        </div>

        {(validationError || authError) && (
          <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">
            {validationError || authError}
          </p>
        )}

        <Button className="w-full" disabled={loading}>
          {loading ? "Creating account..." : "Register"}
        </Button>
      </form>

      <p className="mt-5 text-center text-sm text-slate-500">
        Already have an account?{" "}
        <Link className="text-brand-600" to="/login">
          Login
        </Link>
      </p>
    </AuthShell>
  );
}


export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    try {
      setMessage(await requestPasswordReset(email));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Reset password"
      subtitle="Enter your email and receive a secure reset link."
    >
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div>
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>
        <Button className="w-full" disabled={loading}>
          {loading ? "Sending..." : "Send reset link"}
        </Button>
      </form>
      {message && (
        <p className="mt-3 rounded-md bg-sky-50 p-3 text-sm text-sky-700">{message}</p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>
      )}
      <p className="mt-5 text-center text-sm">
        <Link className="text-brand-600" to="/login">Back to login</Link>
      </p>
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get("token") || "";
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setLoading(true);
    try {
      setMessage(await submitPasswordReset(token, password));
      setTimeout(() => navigate("/login"), 1500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The request failed.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell title="Choose a new password" subtitle="Use at least 8 characters.">
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div>
          <Label htmlFor="password">New password</Label>
          <Input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </div>
        <Button className="w-full" disabled={loading || !token}>
          {loading ? "Saving..." : "Update password"}
        </Button>
      </form>
      {message && (
        <p className="mt-3 rounded-md bg-sky-50 p-3 text-sm text-sky-700">{message}</p>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-700">{error}</p>
      )}
    </AuthShell>
  );
}
