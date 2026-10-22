import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSession } from "../src/lib/auth";
import { MOODS, type Mood } from "../src/lib/moods";
import { useParty } from "../src/party/PartyProvider";
import { c } from "../src/theme";
import { Screen, tap } from "../src/ui/kit";
import { MiniPlayer } from "../src/ui/MiniPlayer";

/** Home (round 4, B): an Ask-the-DJ field over big mood bands. One tap and the music starts. */
export default function Home() {
  const { firstName, email } = useSession();
  const { start } = useParty();
  const [ask, setAsk] = useState("");
  const initial = (firstName ?? email ?? "?").slice(0, 1).toUpperCase();

  // The player opens at once and fills in as the server answers; nothing blocks on the network.
  const play = (m: Pick<Mood, "label" | "vibe" | "moodText">) => {
    void start(m).catch(() => {});
    router.push("/player");
  };
  const askDj = () => {
    const text = ask.trim();
    if (!text) return;
    setAsk("");
    play({ label: text, vibe: { energy: 0.5, valence: 0.5 }, moodText: text });
  };

  return (
    <Screen style={{ paddingHorizontal: 20 }}>
      <View style={st.header}>
        <Text style={st.brand}>theJ</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Settings"
          onPressIn={tap}
          onPress={() => router.push("/settings")}
          style={({ pressed }) => [st.avatar, pressed && st.pressed]}
        >
          <Text style={st.avatarText}>{initial}</Text>
        </Pressable>
      </View>

      <View style={st.ask}>
        <TextInput
          accessibilityLabel="Ask the DJ"
          placeholder="Ask the DJ: a vibe, a song, the room"
          placeholderTextColor={c.dim}
          value={ask}
          onChangeText={setAsk}
          onSubmitEditing={askDj}
          returnKeyType="go"
          style={st.askInput}
        />
        {ask.trim() ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Play this"
            onPressIn={tap}
            onPress={askDj}
            style={({ pressed }) => [st.askGo, pressed && st.pressed]}
          >
            <Ionicons name="arrow-forward" size={20} color={c.bg} />
          </Pressable>
        ) : null}
      </View>

      <ScrollView contentContainerStyle={st.list} showsVerticalScrollIndicator={false}>
        {MOODS.map((m) => (
          <Pressable
            key={m.id}
            accessibilityRole="button"
            accessibilityLabel={`Play ${m.label}`}
            onPressIn={tap}
            onPress={() => play(m)}
            style={({ pressed }) => [st.band, { backgroundColor: m.bg }, pressed && st.pressed]}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={st.name}>{m.label}</Text>
              <Text style={st.line}>{m.line}</Text>
            </View>
            <View style={st.playDot}>
              <Ionicons name="play" size={20} color={c.bg} style={{ marginLeft: 3 }} />
            </View>
          </Pressable>
        ))}
      </ScrollView>

      <View style={{ paddingTop: 8, paddingBottom: 12 }}>
        <MiniPlayer />
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  header: {
    height: 48,
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  brand: { color: c.fg, fontSize: 26, fontWeight: "700", letterSpacing: -0.8 },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#B8754A",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: c.bg, fontSize: 16, fontWeight: "600" },
  ask: {
    marginTop: 14,
    height: 54,
    borderRadius: 16,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.line,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 16,
    paddingRight: 6,
  },
  askInput: { flex: 1, color: c.fg, fontSize: 16, height: 54 },
  askGo: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
  },
  list: { gap: 12, paddingTop: 16, paddingBottom: 8 },
  band: {
    height: 104,
    borderRadius: 20,
    paddingLeft: 22,
    paddingRight: 18,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
  },
  pressed: { transform: [{ scale: 0.98 }], opacity: 0.9 },
  name: { color: "#FFFFFF", fontSize: 26, fontWeight: "700", letterSpacing: -0.6 },
  line: { color: "rgba(255,255,255,0.82)", fontSize: 14 },
  playDot: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
  },
});
