import { useAuth } from "../auth/AuthContext";

export function LoginPage() {
  const { signIn } = useAuth();

  return (
    <div className="app">
      <div className="login-page">
        <h1>Session Scribe</h1>
        <p className="subtitle">Sign in to continue</p>
        <div className="login-button-wrapper">
          <button className="google-sign-in-btn" onClick={signIn}>
            Sign in with Google
          </button>
        </div>
      </div>
    </div>
  );
}
