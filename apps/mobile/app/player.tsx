import Slider from "@react-native-community/slider";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { router } from "expo-router";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { fmtTime } from "../src/lib/types";
import { useNowPlaying, useParty } from "../src/party/PartyProvider";
import { c } from "../src/theme";
import { IconButton } from "../src/ui/kit";
import { Nudges } from "../src/ui/Nudges";

export default function Player() {
  const {
    queue,
    status,
    togglePlay,
    skip,
    jumpNext,
    restart,
    seek,
    repeat,
    toggleRepeat,
    toggleLike,
    press,
    label,
    starting,
    error,
  } = useParty();
  const { now, next } = useNowPlaying();
  const header = (
    <View style={st.top}>
      <IconButton name="chevron-down" label="Minimise player" onPress={() => router.back()} />
      <View style={{ alignItems: "center", gap: 2 }}>
        <Text style={st.djing}>DJING FOR</Text>
        <Text style={st.party} numberOfLines={1}>
          {label ?? "Your mood"}
        </Text>
      </View>
      <IconButton
        name="ellipsis-horizontal"
        label="Settings"
        onPress={() => router.push("/settings")}
      />
    </View>
  );

  // Until the first song is in hand the player still shows its frame, never a blocking page.
  if (!queue || !now) {
    const first = queue?.committed[0];
    return (
      <LinearGradient colors={["#3A2A22", "#161210", "#0B0B0C"]} style={st.fill}>
        <SafeAreaView style={st.fill} edges={["top", "bottom"]}>
          <View style={st.body}>
            {header}
            <View style={st.artWrap}>
              {first ? (
                <Image
                  source={first.thumbUrl}
                  style={[st.art, { opacity: 0.6 }]}
                  contentFit="cover"
                />
              ) : (
                <View style={[st.art, st.artEmpty]} />
              )}
            </View>
            <View style={{ gap: 6, marginTop: 22 }}>
              <Text style={st.title} numberOfLines={1}>
                {first?.title ?? (starting ? "Picking the first song" : "Nothing playing")}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                {starting || first ? <ActivityIndicator size="small" color={c.muted} /> : null}
                <Text style={st.artist}>
                  {first
                    ? `${first.artist} · cueing`
                    : starting
                      ? "One moment"
                      : "Pick a mood on Home"}
                </Text>
              </View>
              {error ? <Text style={[st.artist, { color: "#F0A868" }]}>{error}</Text> : null}
            </View>
          </View>
        </SafeAreaView>
      </LinearGradient>
    );
  }

  return (
    <LinearGradient
      colors={["#6A3A24", "#2C1A12", "#0B0B0C"]}
      locations={[0, 0.46, 0.74]}
      style={st.fill}
    >
      <SafeAreaView style={st.fill} edges={["top", "bottom"]}>
        <ScrollView contentContainerStyle={st.body}>
          {header}

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
              name={queue.liked.includes(now.songId) ? "heart" : "heart-outline"}
              label={queue.liked.includes(now.songId) ? "Unlike" : "Like"}
              color={c.accent}
              onPress={() => void toggleLike()}
            />
          </View>

          <View style={{ gap: 6, marginTop: 12 }}>
            <Slider
              accessibilityLabel="Seek"
              style={st.slider}
              minimumValue={0}
              maximumValue={status.duration || now.durationS || 1}
              value={status.currentTime}
              onSlidingComplete={seek}
              minimumTrackTintColor={c.fg}
              maximumTrackTintColor="rgba(255,255,255,0.18)"
              thumbTintColor={c.fg}
            />
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
              {status.buffering && !status.playing ? (
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
              name={repeat ? "repeat" : "repeat-outline"}
              label={repeat ? "Repeat on" : "Repeat this song"}
              color={repeat ? c.accent : c.fg2}
              onPress={toggleRepeat}
            />
          </View>

          {next ? (
            <Pressable
              accessibilityLabel={`Play ${next.title} now`}
              onPress={jumpNext}
              style={st.next}
            >
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
            <Nudges queue={queue} onPress={(b, n) => void press(b, n).catch(() => {})} />
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
  artEmpty: { backgroundColor: "rgba(255,255,255,0.06)" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 22 },
  title: { color: c.fg, fontSize: 22, fontWeight: "600", letterSpacing: -0.3 },
  artist: { color: c.warm, fontSize: 15 },
  pill: {
    height: 26,
    paddingHorizontal: 10,
    borderRadius: 13,
    backgroundColor: "rgba(255,255,255,0.1)",
    justifyContent: "center",
  },
  pillText: { color: c.fg, fontSize: 12, fontWeight: "500" },
  slider: { height: 28, marginHorizontal: -8 },
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
