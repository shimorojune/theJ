import { useAuth, useUser } from "@clerk/expo";
import { useCallback } from "react";

/** Set EXPO_PUBLIC_DEV_USER to skip Clerk; the api accepts the same name in dev (DEV_AUTH=1). */
export const DEV_USER = process.env.EXPO_PUBLIC_DEV_USER || null;

export type SessionInfo = {
  isLoaded: boolean;
  isSignedIn: boolean;
  getToken: () => Promise<string | null>;
  signOut: () => Promise<void>;
  /** Display name and email, from Clerk or the dev user. */
  firstName: string | null;
  email: string | null;
  onboarded: boolean;
  markOnboarded: () => Promise<void>;
};

export function useSession(): SessionInfo {
  const auth = useAuth();
  const { user } = useUser();
  const getToken = useCallback(
    () => (DEV_USER ? Promise.resolve(null) : auth.getToken()),
    [auth.getToken],
  );
  if (DEV_USER) {
    return {
      isLoaded: true,
      isSignedIn: true,
      getToken,
      signOut: async () => {},
      firstName: DEV_USER,
      email: `${DEV_USER}@dev.local`,
      onboarded: true,
      markOnboarded: async () => {},
    };
  }
  return {
    isLoaded: auth.isLoaded,
    isSignedIn: Boolean(auth.isSignedIn),
    getToken,
    signOut: () => auth.signOut(),
    firstName: user?.firstName ?? null,
    email: user?.primaryEmailAddress?.emailAddress ?? null,
    onboarded: Boolean(user?.unsafeMetadata?.onboarded),
    markOnboarded: async () => {
      if (user && !user.unsafeMetadata?.onboarded) {
        await user.updateMetadata({ unsafeMetadata: { onboarded: true } });
      }
    },
  };
}
