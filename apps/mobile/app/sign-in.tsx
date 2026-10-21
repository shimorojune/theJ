import { useSSO } from "@clerk/expo";
import { useHostedAuth } from "@clerk/expo/hosted-auth";
import { router } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { useState } from "react";
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { c } from "../src/theme";
import { s as kit, PrimaryButton, Screen } from "../src/ui/kit";

WebBrowser.maybeCompleteAuthSession();

const TILES = [
  "#B8754A",
  "#46629E",
  "#6E5BB0",
  "#3E7A6A",
  "#B5607A",
  "#7E3434",
  "#B8954A",
  "#2F5A6B",
  "#A84A40",
  "#5B4A8A",
  "#4E6B44",
  "#8A6A3A",
  "#3D3D44",
  "#B8754A",
  "#6E5BB0",
  "#B5607A",
  "#46629E",
  "#7A5236",
  "#3E7A6A",
  "#A84A40",
];
const TILE_LIST = TILES.map((bg, i) => ({ id: `tile-${i}`, bg }));

export default function SignIn() {
  const { startSSOFlow } = useSSO();
  const { startHostedAuth } = useHostedAuth();
  const [busy, setBusy] = useState(false);
  const tile = (useWindowDimensions().width + 60 - 30) / 4;
  const [error, setError] = useState<string | null>(null);

  const google = async () => {
    setBusy(true);
    setError(null);
    try {
      const { createdSessionId, setActive } = await startSSOFlow({ strategy: "oauth_google" });
      if (createdSessionId && setActive) {
        await setActive({ session: createdSessionId });
        router.replace("/");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const email = async () => {
    setError(null);
    try {
      const { createdSessionId } = await startHostedAuth({ mode: "sign-in" });
      if (createdSessionId) router.replace("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Screen style={{ paddingHorizontal: 28 }}>
      <View pointerEvents="none" style={[st.tiles, { height: tile * 5 + 40 }]}>
        {TILE_LIST.map((t) => (
          <View
            key={t.id}
            style={[st.tile, { width: tile, height: tile, backgroundColor: t.bg }]}
          />
        ))}
      </View>
      <View pointerEvents="none" style={st.fadeTop} />
      <View pointerEvents="none" style={st.fade} />
      <View style={{ marginTop: "auto", gap: 12 }}>
        <Text style={st.brand}>theJ</Text>
        <Text style={[kit.lede, { fontSize: 17 }]}>
          Tell it the vibe. It reads the room and keeps the music going all night.
        </Text>
      </View>
      <View style={{ gap: 10, marginTop: 32, marginBottom: 16 }}>
        <PrimaryButton label="Continue with Google" onPress={google} busy={busy} />
        <Pressable accessibilityRole="button" onPress={email} style={st.email}>
          <Text style={st.emailText}>Use email instead</Text>
        </Pressable>
        {error ? <Text style={st.error}>{error}</Text> : null}
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  tiles: {
    position: "absolute",
    left: -30,
    right: -30,
    top: -20,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 10,
    transform: [{ rotate: "-8deg" }],
  },
  tile: { borderRadius: 6 },
  fade: { position: "absolute", left: 0, right: 0, top: "35%", bottom: 0, backgroundColor: c.bg },
  fadeTop: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: "35%",
    backgroundColor: "rgba(11,11,12,0.35)",
  },
  brand: { color: c.fg, fontSize: 40, fontWeight: "600", letterSpacing: -1.4 },
  email: {
    height: 52,
    borderRadius: 26,
    borderWidth: 1,
    borderColor: "#333337",
    alignItems: "center",
    justifyContent: "center",
  },
  emailText: { color: c.fg, fontSize: 15, fontWeight: "500" },
  error: { color: "#F0A868", fontSize: 13, textAlign: "center" },
});
