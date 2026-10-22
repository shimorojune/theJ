import { Image } from "expo-image";
import { router } from "expo-router";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useNowPlaying, useParty, useProgress } from "../party/PartyProvider";
import { c } from "../theme";
import { IconButton, tap } from "./kit";

export function MiniPlayer() {
  const { status, togglePlay, skip } = useParty();
  const { now } = useNowPlaying();
  if (!now) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Open player"
      onPressIn={tap}
      onPress={() => router.push("/player")}
      style={({ pressed }) => [st.bar, pressed && { opacity: 0.85 }]}
    >
      <Image source={now.thumbUrl} style={st.art} contentFit="cover" />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={st.title} numberOfLines={1}>
          {now.title}
        </Text>
        <Text style={st.sub} numberOfLines={1}>
          {now.artist}
          {now.tempo ? ` · ${now.tempo} BPM` : ""}
        </Text>
      </View>
      <IconButton
        name={status.playing ? "pause" : "play"}
        label={status.playing ? "Pause" : "Play"}
        onPress={togglePlay}
      />
      <IconButton name="play-skip-forward" label="Skip song" onPress={skip} />
      <Track duration={status.duration} />
    </Pressable>
  );
}

/** The progress line; only this re-renders as the song plays. */
function Track({ duration }: { duration: number }) {
  const time = useProgress();
  const progress = duration ? Math.min(1, time / duration) : 0;
  return (
    <View style={st.track}>
      <View style={[st.fill, { width: `${progress * 100}%` }]} />
    </View>
  );
}

const st = StyleSheet.create({
  bar: {
    height: 60,
    borderRadius: 10,
    backgroundColor: "#3A2418",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 8,
    paddingRight: 6,
    overflow: "hidden",
  },
  art: { width: 44, height: 44, borderRadius: 4 },
  title: { color: c.fg, fontSize: 14, fontWeight: "500" },
  sub: { color: "#C9B6A8", fontSize: 12 },
  track: {
    position: "absolute",
    left: 8,
    right: 8,
    bottom: 0,
    height: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  fill: { height: 2, backgroundColor: c.fg },
});
