import { SignInButton } from "@clerk/react";

export function SignIn() {
  return (
    <main className="screen">
      <div className="center">
        <div>
          <h1 style={{ fontSize: 40, margin: 0, letterSpacing: "-0.02em" }}>theJ</h1>
          <p className="muted">A DJ for your party that learns as it plays.</p>
        </div>
        <SignInButton mode="modal">
          <button type="button" className="btn-primary">
            Sign in
          </button>
        </SignInButton>
      </div>
    </main>
  );
}
