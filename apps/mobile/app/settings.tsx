import { router } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { useSession } from "../src/lib/auth";
import { type LanguageChoice, toChoice, toLanguages, usePrefs } from "../src/lib/prefs";
import { useParty } from "../src/party/PartyProvider";
import { c } from "../src/theme";
import { GhostButton, IconButton, PrimaryButton, Screen } from "../src/ui/kit";
import { LanguagePicker } from "../src/ui/LanguagePicker";

export default function Settings() {
  const { signOut, email } = useSession();
  const { load, save } = usePrefs();
  const { queue, end } = useParty();
  const [choice, setChoice] = useState<LanguageChoice>("mix");
  const [hiShare, setHiShare] = useState(0.5);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void load()
      .then((p) => {
        setChoice(toChoice(p.languages));
        setHiShare(p.mixRatio);
      })
      .catch(() => {});
  }, [load]);

  return (
    <Screen>
      <View style={st.top}>
        <IconButton name="chevron-back" label="Back" onPress={() => router.back()} />
        <Text style={st.topTitle}>Settings</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={{ gap: 16, paddingBottom: 24 }}>
        <Text style={st.section}>Languages</Text>
        <LanguagePicker
          choice={choice}
          hiShare={hiShare}
          onChoice={(x) => {
            setChoice(x);
            setSaved(false);
          }}
          onHiShare={(n) => {
            setHiShare(n);
            setSaved(false);
          }}
        />
        <PrimaryButton
          label={saved ? "Saved. Applies to your next mood" : "Save"}
          onPress={() =>
            void save({ languages: toLanguages(choice), mixRatio: hiShare }).then(() =>
              setSaved(true),
            )
          }
        />
        {queue ? (
          <GhostButton
            label="Stop the music"
            onPress={() => void end().then(() => router.replace("/home"))}
          />
        ) : null}
        <Text style={st.meta}>Signed in as {email}</Text>
        <GhostButton
          label="Sign out"
          onPress={() =>
            void end()
              .then(() => signOut())
              .then(() => router.replace("/sign-in"))
          }
        />
      </ScrollView>
    </Screen>
  );
}

const st = StyleSheet.create({
  top: {
    height: 44,
    marginTop: 6,
    marginHorizontal: -12,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 12,
  },
  topTitle: { color: c.fg, fontSize: 15, fontWeight: "600" },
  section: { color: c.fg, fontSize: 16, fontWeight: "600" },
  meta: { color: c.dim, fontSize: 12, textAlign: "center", marginTop: 12 },
});
