import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fmtTime } from "../src/lib/types";
import { useNowPlaying, useParty } from "../src/party/PartyProvider";
import { c } from "../src/theme";
import { IconButton } from "../src/ui/kit";
import { VibeCard } from "../src/ui/VibeCard";

export default function Player() {
  const { queue, status, togglePlay, skip, restart, like, press, error } = useParty();
  const { now, next } = useNowPlaying();
  const [liked, setLiked] = useState<string | null>(null);

  if (!queue || !now) {
    return (
      <View
        style={[st.fill, { justifyContent: "center", alignItems: "center", gap: 14, padding: 32 }]}
      >
        <ActivityIndicator color={c.fg} />
        <Text style={st.sub}>
          {queue ? "Waiting for the first songs to be ready…" : "No party running"}
        </Text>
        {error ? <Text style={[st.sub, { color: "#F0A868" }]}>{error}</Text> : null}
        {!queue ? (
          <IconButton name="chevron-down" label="Back" onPress={() => router.back()} />
        ) : null}
      </View>
    );
  }
  const progress = status.duration ? status.currentTime / status.duration : 0;

  return (
    <LinearGradient
      colors={["#6A3A24", "#2C1A12", "#0B0B0C"]}
      locations={[0, 0.46, 0.74]}
      style={st.fill}
    >
      <SafeAreaView style={st.fill} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={st.body}>
          <View style={st.top}>
            <IconButton name="chevron-down" label="Minimise player" onPress={() => router.back()} />
            <View style={{ alignItems: "center", gap: 2 }}>
              <Text style={st.djing}>DJING FOR</Text>
              <Text style={st.party}>Your party</Text>
            </View>
            <IconButton
              name="ellipsis-horizontal"
              label="Settings"
              onPress={() => router.push("/settings")}
            />
          </View>

          <View style={st.artWrap}>
            <Image
              source={now.thumbUrl}
              style={st.art}
              contentFit="cover"
              transition={250}
              accessibilityLabel={`Album art for ${now.title}`}
            />
          </View>

          <View style={st.titleRow}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={st.title} numberOfLines={1}>
                {now.title}
              </Text>
              <Text style={st.artist} numberOfLines={1}>
                {now.artist}
              </Text>
            </View>
            {now.tempo ? (
              <View style={st.pill}>
                <Text style={st.pillText}>{now.tempo} BPM</Text>
              </View>
            ) : null}
            <IconButton
              name={liked === now.videoId ? "heart" : "heart-outline"}
              label={liked === now.videoId ? "Liked" : "Like"}
              color={c.accent}
              onPress={() => {
                setLiked(now.videoId);
                void like();
              }}
            />
          </View>

          <View style={{ gap: 6, marginTop: 12 }}>
            <View style={st.track}>
              <View style={[st.trackFill, { width: `${progress * 100}%` }]} />
            </View>
            <View style={st.times}>
              <Text style={st.time}>{fmtTime(status.currentTime)}</Text>
              <Text style={st.time}>{fmtTime(status.duration || now.durationS)}</Text>
            </View>
          </View>

          <View style={st.controls}>
            <IconButton
              name="list"
              label="Open queue"
              color={c.fg2}
              onPress={() => router.push("/queue")}
            />
            <IconButton name="play-skip-back" label="Restart song" size={26} onPress={restart} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={status.playing ? "Pause" : "Play"}
              onPress={togglePlay}
              style={st.play}
            >
              {status.isBuffering && !status.playing ? (
                <ActivityIndicator color={c.bg} />
              ) : (
                <IconButton
                  name={status.playing ? "pause" : "play"}
                  label=""
                  color={c.bg}
                  onPress={togglePlay}
                />
              )}
            </Pressable>
            <IconButton name="play-skip-forward" label="Skip song" size={26} onPress={skip} />
            <IconButton
              name="chatbubble-outline"
              label="Ask the DJ (coming soon)"
              color="#5A5A60"
            />
          </View>

          {next ? (
            <Pressable onPress={() => router.push("/queue")} style={st.next}>
              <Image source={next.thumbUrl} style={st.nextArt} contentFit="cover" />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={st.upNext}>UP NEXT</Text>
                <Text style={st.nextTitle} numberOfLines={1}>
                  {next.title} · {next.artist.split(",")[0]}
                </Text>
                {next.tempo ? <Text style={st.time}>{next.tempo} BPM</Text> : null}
              </View>
            </Pressable>
          ) : null}

          <View style={{ marginTop: 10 }}>
            <VibeCard queue={queue} onPress={(b, n) => void press(b, n)} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </LinearGradient>
  );
}

const st = StyleSheet.create({
  fill: { flex: 1, backgroundColor: c.bg },
  body: { paddingHorizontal: 24, paddingBottom: 24 },
  top: {
    height: 44,
    marginTop: 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginHorizontal: -12,
  },
  djing: { color: "#D8C3B4", fontSize: 11, letterSpacing: 0.7 },
  party: { color: c.fg, fontSize: 13, fontWeight: "600" },
  artWrap: { alignItems: "center", marginTop: 14 },
  art: { width: "100%", aspectRatio: 1, maxWidth: 340, borderRadius: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 22 },
  title: { color: c.fg, fontSize: 22, fontWeight: "600", letterSpacing: -0.3 },
  artist: { color: c.warm, fontSize: 15 },
  sub: { color: c.muted, fontSize: 14, textAlign: "center" },
  pill: {
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    backgroundColor: "rgba(255,255,255,0.1)",
    justifyContent: "center",
  },
  pillText: { color: c.fg, fontSize: 12, fontWeight: "500" },
  track: { height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.18)" },
  trackFill: { height: 3, borderRadius: 2, backgroundColor: c.fg },
  times: { flexDirection: "row", justifyContent: "space-between" },
  time: { color: c.dim, fontSize: 12 },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 4,
    marginHorizontal: -10,
  },
  play: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
  },
  next: {
    marginTop: 14,
    backgroundColor: c.card,
    borderRadius: 14,
    padding: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  nextArt: { width: 48, height: 48, borderRadius: 4 },
  upNext: { color: c.muted, fontSize: 11, letterSpacing: 0.7 },
  nextTitle: { color: c.fg, fontSize: 15, fontWeight: "500" },
});
