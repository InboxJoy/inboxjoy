"use client";

import { SignupForm } from "../signup/signup-form";

// First-run setup: shown while the server has no account yet. The account made
// here owns the first workspace; once it exists this page sends people to sign in.
export default function SetupPage() {
  return <SignupForm variant="setup" />;
}
