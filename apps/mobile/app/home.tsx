import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useSession } from "../src/lib/auth";
import { useNowPlaying, useParty } from "../src/party/PartyProvider";
import { c } from "../src/theme";
import { Screen } from "../src/ui/kit";
import { MiniPlayer } from "../src/ui/MiniPlayer";
import { VibeTiles } from "../src/ui/VibeTiles";

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
};

export default function Home() {
  const { firstName, email } = useSession();
  const { queue } = useParty();
  const { now } = useNowPlaying();
  const initial = (firstName ?? email ?? "?").slice(0, 1).toUpperCase();

  return (
    <Screen style={{ paddingHorizontal: 20 }}>
      <View style={st.header}>
        <Text style={st.hello}>{greeting()}</Text>
        <Pressable
          accessibilityLabel="Settings"
          onPress={() => router.push("/settings")}
          style={st.avatar}
        >
          <Text style={st.avatarText}>{initial}</Text>
        </Pressable>
      </View>

      {queue && now ? (
        <Pressable onPress={() => router.push("/player")}>
          <LinearGradient
            colors={["#6A3A24", "#2C1A12"]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={st.live}
          >
            <View style={st.liveRow}>
              <View style={st.dot} />
              <Text style={st.liveText}>Live now</Text>
            </View>
            <View style={{ flexDirection: "row", gap: 14, alignItems: "center" }}>
              <Image source={now.thumbUrl} style={st.liveArt} contentFit="cover" />
              <View style={{ flex: 1, gap: 3 }}>
                <Text style={st.liveTitle}>{firstName ? `${firstName}'s mood` : "Your mood"}</Text>
                <Text style={st.liveSub} numberOfLines={1}>
                  {now.title}
                </Text>
                <Text style={st.liveSub}>{now.tempo ? `${now.tempo} BPM now` : ""}</Text>
              </View>
            </View>
            <View style={st.open}>
              <Text style={st.openText}>Open player</Text>
            </View>
          </LinearGradient>
        </Pressable>
      ) : null}

      <View style={st.sectionRow}>
        <Text style={st.section}>Set a mood</Text>
        <Pressable
          onPress={() => router.push({ pathname: "/onboarding/vibe", params: { standalone: "1" } })}
        >
          <Text style={st.more}>More</Text>
        </Pressable>
      </View>
      <VibeTiles
        compact
        onPick={(id) =>
          router.push({ pathname: "/onboarding/vibe", params: { vibe: id, standalone: "1" } })
        }
      />

      <View style={{ marginTop: "auto", marginBottom: 12 }}>
        <MiniPlayer />
      </View>
    </Screen>
  );
}

const st = StyleSheet.create({
  header: {
    height: 44,
    marginTop: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  hello: { color: c.fg, fontSize: 24, fontWeight: "600", letterSpacing: -0.5 },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "#B8754A",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: c.bg, fontSize: 15, fontWeight: "600" },
  live: { marginTop: 18, borderRadius: 16, padding: 16, gap: 14 },
  liveRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: c.accent },
  liveText: { color: "#E8D3C4", fontSize: 12 },
  liveArt: { width: 72, height: 72, borderRadius: 6 },
  liveTitle: { color: c.fg, fontSize: 18, fontWeight: "600" },
  liveSub: { color: "#D0C2B8", fontSize: 13 },
  open: {
    height: 40,
    borderRadius: 20,
    backgroundColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
  },
  openText: { color: c.bg, fontSize: 14, fontWeight: "500" },
  sectionRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginTop: 28,
    marginBottom: 12,
  },
  section: { color: c.fg, fontSize: 18, fontWeight: "600" },
  more: { color: c.muted, fontSize: 13 },
});
