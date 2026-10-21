import { Redirect } from "expo-router";

/** Clerk's SSO flow returns to thej://sso-callback; the index decides where to go next. */
export default function SsoCallback() {
  return <Redirect href="/" />;
}
