import { GoogleLogin } from "@react-oauth/google";
import { useAuth } from "../auth/AuthContext";

export function LoginPage() {
  const { login } = useAuth();

  return (
    <div className="app">
      <div className="login-page">
        <h1>Session Scribe</h1>
        <p className="subtitle">Sign in with your Google account to continue</p>
        <div className="login-button-wrapper">
          <GoogleLogin
            onSuccess={(response) => {
              if (response.credential) login(response.credential);
            }}
            onError={() => console.error("Google login failed")}
            size="large"
            theme="outline"
          />
        </div>
      </div>
    </div>
  );
}
