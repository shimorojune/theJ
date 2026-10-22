import { useQuery } from "@tanstack/react-query";
import { Image } from "expo-image";
import { router } from "expo-router";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { fmtTime, heading, type Song } from "../src/lib/types";
import { useNowPlaying, useParty } from "../src/party/PartyProvider";
import { c } from "../src/theme";
import { IconButton, Screen } from "../src/ui/kit";

const why = (s: Song, prev: Song | undefined) => {
  if (!prev || s.energy == null || prev.energy == null) return s.artist.split(",")[0];
  const d = s.energy - prev.energy;
  return d > 0.05
    ? "A step up in energy"
    : d < -0.05
      ? "Taking it down a notch"
      : "Same energy, keeps it rolling";
};

export default function Queue() {
  const { queue, upcoming } = useParty();
  const { now } = useNowPlaying();
  const plan = useQuery({
    queryKey: ["plan", queue?.sessionId, queue?.goal, now?.songId],
    queryFn: upcoming,
    enabled: Boolean(queue),
  });
  if (!queue) return null;
  const next = queue.committed.filter((s) => s.songId !== now?.songId);

  return (
    <Screen>
      <View style={st.top}>
        <IconButton name="chevron-down" label="Back to player" onPress={() => router.back()} />
        <Text style={st.topTitle}>Queue</Text>
        <View style={{ width: 44 }} />
      </View>
      <ScrollView contentContainerStyle={{ gap: 22, paddingBottom: 24 }}>
        <View style={st.banner}>
          <View style={st.dot} />
          <View style={{ gap: 2 }}>
            <Text style={st.bannerTitle}>{heading(queue)}</Text>
            <Text style={st.meta}>
              Energy {Math.round(queue.target.energy * 100)}% →{" "}
              {Math.round(queue.goal.energy * 100)}% · Mood {Math.round(queue.target.valence * 100)}
              % → {Math.round(queue.goal.valence * 100)}%
            </Text>
          </View>
        </View>

        {now ? (
          <View style={{ gap: 12 }}>
            <Text style={st.section}>Now playing</Text>
            <Row song={now} accent />
          </View>
        ) : null}

        <View style={{ gap: 12 }}>
          <View style={st.sectionRow}>
            <Text style={st.section}>Next up</Text>
            <Text style={st.meta}>Ready to play</Text>
          </View>
          {next.map((s) => (
            <Row key={s.songId} song={s} />
          ))}
        </View>

        <View style={{ gap: 12 }}>
          <View style={st.sectionRow}>
            <Text style={st.section}>The DJ's plan</Text>
            <Text style={st.meta}>Changes with the vibe</Text>
          </View>
          {(plan.data ?? []).map((s, i, all) => (
            <Row key={s.songId} song={s} faded subtitle={why(s, all[i - 1] ?? next.at(-1))} />
          ))}
        </View>
      </ScrollView>
    </Screen>
  );
}

function Row({
  song,
  accent,
  faded,
  subtitle,
}: {
  song: Song;
  accent?: boolean;
  faded?: boolean;
  subtitle?: string;
}) {
  return (
    <View style={st.row}>
      <Image
        source={song.thumbUrl}
        style={[st.art, faded && { opacity: 0.55 }]}
        contentFit="cover"
      />
      <View style={{ flex: 1, gap: 3 }}>
        <Text
          style={[st.title, accent && { color: c.accent }, faded && { color: c.muted }]}
          numberOfLines={1}
        >
          {song.title}
        </Text>
        <Text style={[st.meta, faded && { color: c.faint }]} numberOfLines={1}>
          {subtitle ?? song.artist}
        </Text>
      </View>
      {faded ? null : <Text style={st.meta}>{fmtTime(song.durationS)}</Text>}
    </View>
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
  banner: {
    backgroundColor: c.surface,
    borderRadius: 12,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.accent },
  bannerTitle: { color: c.fg, fontSize: 14, fontWeight: "500" },
  section: { color: c.fg, fontSize: 16, fontWeight: "600" },
  sectionRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  meta: { color: c.dim, fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  art: { width: 48, height: 48, borderRadius: 4 },
  title: { color: c.fg, fontSize: 15, fontWeight: "500" },
});
