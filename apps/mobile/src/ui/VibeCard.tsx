import type { Button } from "@thej/shared";
import * as Haptics from "expo-haptics";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { type Queue, songsLeft } from "../lib/types";
import { c } from "../theme";

/** Two axes (energy, mood). The white bar is where the music is; the gold ring is where it's heading. */
export function VibeCard({
  queue,
  onPress,
}: {
  queue: Queue;
  onPress: (b: Button, now: boolean) => void;
}) {
  const left = songsLeft(queue);
  const press = (b: Button, now: boolean) => {
    void Haptics.impactAsync(
      now ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
    );
    onPress(b, now);
  };
  const row = (
    low: Button,
    high: Button,
    lowLabel: string,
    highLabel: string,
    now: number,
    goal: number,
    label: string,
  ) => (
    <View style={st.row}>
      <Side
        label={lowLabel}
        onTap={() => press(low, false)}
        onHold={() => press(low, true)}
        align="left"
      />
      <View accessible accessibilityLabel={label} style={st.track}>
        <View style={[st.fill, { width: `${now * 100}%` }]} />
        <View style={[st.goal, { left: `${goal * 100}%` }]} />
      </View>
      <Side
        label={highLabel}
        onTap={() => press(high, false)}
        onHold={() => press(high, true)}
        align="right"
      />
    </View>
  );
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return (
    <View style={st.card}>
      <View style={st.head}>
        <Text style={st.title}>Vibe</Text>
        <View style={st.status}>
          <View style={[st.dot, { backgroundColor: left ? c.accent : "#6E6E75" }]} />
          <Text style={st.statusText}>
            {left ? `Easing in over ${left} song${left > 1 ? "s" : ""}` : "Holding steady"}
          </Text>
        </View>
      </View>
      {row(
        "chill",
        "hype",
        "Chill",
        "Hype",
        queue.target.energy,
        queue.goal.energy,
        `Energy now ${pct(queue.target.energy)}, heading to ${pct(queue.goal.energy)}`,
      )}
      {row(
        "moodier",
        "brighter",
        "Moodier",
        "Brighter",
        queue.target.valence,
        queue.goal.valence,
        `Mood now ${pct(queue.target.valence)}, heading to ${pct(queue.goal.valence)}`,
      )}
      <Text style={st.hint}>Tap to ease in. Hold to switch now.</Text>
    </View>
  );
}

function Side(props: {
  label: string;
  onTap: () => void;
  onHold: () => void;
  align: "left" | "right";
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Hold to change now"
      onPress={props.onTap}
      onLongPress={props.onHold}
      delayLongPress={450}
      style={({ pressed }) => [
        st.side,
        { alignItems: props.align === "left" ? "flex-start" : "flex-end" },
        pressed && { opacity: 0.6 },
      ]}
    >
      <Text style={st.sideText}>{props.label}</Text>
    </Pressable>
  );
}

const st = StyleSheet.create({
  card: {
    backgroundColor: c.card,
    borderRadius: 14,
    paddingTop: 12,
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: c.fg, fontSize: 14, fontWeight: "600" },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { color: c.muted, fontSize: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 10 },
  side: { width: 70, height: 44, justifyContent: "center" },
  sideText: { color: c.fg2, fontSize: 14, fontWeight: "500" },
  track: { flex: 1, height: 3, borderRadius: 2, backgroundColor: c.track },
  fill: { height: 3, borderRadius: 2, backgroundColor: c.fg },
  goal: {
    position: "absolute",
    top: -5,
    width: 11,
    height: 11,
    marginLeft: -6,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: c.accent,
    backgroundColor: "#1A1715",
  },
  hint: { color: c.faint, fontSize: 11, textAlign: "center", marginTop: 2 },
});
