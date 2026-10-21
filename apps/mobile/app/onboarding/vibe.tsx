import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";
import { useParty } from "../../src/party/PartyProvider";
import { VIBES } from "../../src/theme";
import { PrimaryButton, Screen, StepBar, s } from "../../src/ui/kit";
import { type VibeId, VibeTiles } from "../../src/ui/VibeTiles";

export default function StartVibe() {
  const params = useLocalSearchParams<{ languages?: string; vibe?: VibeId; standalone?: string }>();
  const { start, starting, error } = useParty();
  const [picked, setPicked] = useState<VibeId>(params.vibe ?? "warm");

  const go = async () => {
    const vibe = VIBES.find((v) => v.id === picked)?.vibe ?? { energy: 0.5, valence: 0.5 };
    const languages = (params.languages ?? "en,hi").split(",") as ("en" | "hi")[];
    await start(languages, vibe);
    router.replace("/player");
  };

  return (
    <Screen>
      <StepBar step={params.standalone ? 1 : 2} of={params.standalone ? 1 : 2} />
      <View style={{ gap: 10, marginTop: 28, marginBottom: 24 }}>
        <Text style={s.h1}>How's the room right now?</Text>
        <Text style={s.lede}>Pick a starting point. You steer from the player.</Text>
      </View>
      <VibeTiles picked={picked} onPick={setPicked} />
      <View style={{ marginTop: "auto", marginBottom: 12, gap: 12 }}>
        {error ? (
          <Text style={{ color: "#F0A868", fontSize: 13, textAlign: "center" }}>{error}</Text>
        ) : null}
        <PrimaryButton
          label="Start the party"
          onPress={() => void go().catch(() => {})}
          busy={starting}
        />
        <Text style={{ color: "#6E6E75", fontSize: 12, textAlign: "center" }}>
          The first song starts right away.
        </Text>
      </View>
    </Screen>
  );
}
