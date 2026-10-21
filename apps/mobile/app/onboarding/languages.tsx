import { router } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { type LanguageChoice, toLanguages, usePrefs } from "../../src/lib/prefs";
import { PrimaryButton, Screen, StepBar, s } from "../../src/ui/kit";
import { LanguagePicker } from "../../src/ui/LanguagePicker";

export default function Languages() {
  const { save } = usePrefs();
  const [choice, setChoice] = useState<LanguageChoice>("mix");
  const [hiShare, setHiShare] = useState(0.6);
  const [busy, setBusy] = useState(false);

  const next = async () => {
    setBusy(true);
    try {
      await save({ languages: toLanguages(choice), mixRatio: hiShare });
      router.push({
        pathname: "/onboarding/vibe",
        params: { languages: toLanguages(choice).join(",") },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <StepBar step={1} of={2} />
      <View style={{ gap: 10, marginTop: 28, marginBottom: 28 }}>
        <Text style={s.h1}>What should the DJ play?</Text>
        <Text style={s.lede}>This shapes every set. You can change it any time in Settings.</Text>
      </View>
      <LanguagePicker
        choice={choice}
        hiShare={hiShare}
        onChoice={setChoice}
        onHiShare={setHiShare}
      />
      <View style={{ marginTop: "auto", marginBottom: 12 }}>
        <PrimaryButton label="Continue" onPress={next} busy={busy} />
      </View>
    </Screen>
  );
}
