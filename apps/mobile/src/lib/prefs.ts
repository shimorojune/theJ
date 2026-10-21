import { useUser } from "@clerk/expo";
import { useCallback } from "react";
import { ok, useApi } from "./api";

export type LanguageChoice = "en" | "hi" | "mix";
export type Prefs = { languages: ("en" | "hi")[]; mixRatio: number };

export const toLanguages = (choice: LanguageChoice): ("en" | "hi")[] =>
  choice === "mix" ? ["en", "hi"] : [choice];

export const toChoice = (languages: string[]): LanguageChoice =>
  languages.includes("en") && languages.includes("hi")
    ? "mix"
    : languages.includes("hi")
      ? "hi"
      : "en";

/** Server-side prefs (used by the DJ) plus an onboarded flag on the Clerk user. */
export function usePrefs() {
  const api = useApi();
  const { user } = useUser();
  const load = useCallback(async () => ok<Prefs>(await api.me.$get()), [api]);
  const save = useCallback(
    async (prefs: Prefs) => {
      await ok(await api.me.$put({ json: prefs }));
      if (user && !user.unsafeMetadata?.onboarded) {
        await user.updateMetadata({ unsafeMetadata: { onboarded: true } });
      }
    },
    [api, user],
  );
  return { load, save };
}
