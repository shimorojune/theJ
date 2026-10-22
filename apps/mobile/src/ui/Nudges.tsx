import { Ionicons } from "@expo/vector-icons";
import type { Button } from "@thej/shared";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Queue } from "../lib/types";
import { c } from "../theme";
import { tap } from "./kit";

const NUDGES: { button: Button; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { button: "hype", label: "More energy", icon: "arrow-up" },
  { button: "chill", label: "Less energy", icon: "arrow-down" },
  { button: "brighter", label: "Happier", icon: "happy-outline" },
  { button: "moodier", label: "Sadder", icon: "sad-outline" },
];

const energyWord = (e: number) =>
  e > 0.75 ? "Hype" : e > 0.5 ? "Lively" : e > 0.25 ? "Relaxed" : "Calm";
const feelWord = (v: number) =>
  v > 0.75 ? "happy" : v > 0.5 ? "upbeat" : v > 0.25 ? "bittersweet" : "sad";

/**
 * The mood control (round 4, C): four nudges, one step each. "From the next song" eases there;
 * "Mix it in now" hands over to a fitting song straight away.
 */
export function Nudges({
  queue,
  onPress,
}: {
  queue: Queue;
  onPress: (button: Button, now: boolean) => void;
}) {
  const [now, setNow] = useState(false);
  const goal = queue.goal;

  return (
    <View style={st.card}>
      <View style={st.head}>
        <Text style={st.title}>Steer the music</Text>
        <Text style={st.word}>
          {energyWord(goal.energy)}, {feelWord(goal.valence)}
        </Text>
      </View>

      <View style={st.grid}>
        {NUDGES.map((n) => (
          <Pressable
            key={n.button}
            accessibilityRole="button"
            accessibilityLabel={`${n.label}${now ? ", now" : ", from the next song"}`}
            onPress={() => {
              void Haptics.impactAsync(
                now ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
              );
              onPress(n.button, now);
            }}
            style={({ pressed }) => [st.nudge, pressed && st.pressed]}
          >
            <Ionicons name={n.icon} size={24} color={c.fg} />
            <Text style={st.nudgeText}>{n.label}</Text>
          </Pressable>
        ))}
      </View>

      <Meter name="Energy" value={goal.energy} color={c.fg} />
      <Meter name="Feel" value={goal.valence} color={c.accent} />

      <View style={st.seg}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: !now }}
          onPressIn={tap}
          onPress={() => setNow(false)}
          style={({ pressed }) => [st.segBtn, !now && st.segOn, pressed && { opacity: 0.7 }]}
        >
          <Text style={[st.segText, !now && st.segTextOn]}>From the next song</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: now }}
          onPressIn={tap}
          onPress={() => setNow(true)}
          style={({ pressed }) => [st.segBtn, now && st.segOn, pressed && { opacity: 0.7 }]}
        >
          <Text style={[st.segText, now && st.segTextOn]}>Mix it in now</Text>
        </Pressable>
      </View>
    </View>
  );
}

function Meter({ name, value, color }: { name: string; value: number; color: string }) {
  const lit = Math.round(value * 10);
  return (
    <View
      style={st.meter}
      accessible
      accessibilityLabel={`${name} ${Math.round(value * 100)} percent`}
    >
      <Text style={st.meterName}>{name}</Text>
      <View style={st.cells}>
        {Array.from({ length: 10 }, (_, i) => (
          <View
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed ten-cell meter
            key={i}
            style={[st.cell, { backgroundColor: i < lit ? color : "rgba(255,255,255,0.12)" }]}
          />
        ))}
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: c.card, borderRadius: 18, padding: 14, gap: 12 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  title: { color: c.fg, fontSize: 16, fontWeight: "600" },
  word: { color: c.accent, fontSize: 13, fontWeight: "500" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  nudge: {
    width: "48%",
    flexGrow: 1,
    height: 84,
    borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.08)",
    padding: 12,
    justifyContent: "space-between",
  },
  pressed: { backgroundColor: "rgba(255,255,255,0.16)", transform: [{ scale: 0.98 }] },
  nudgeText: { color: c.fg, fontSize: 16, fontWeight: "600" },
  meter: { flexDirection: "row", alignItems: "center", gap: 10 },
  meterName: { color: c.muted, fontSize: 12, width: 48 },
  cells: { flex: 1, flexDirection: "row", gap: 3 },
  cell: { flex: 1, height: 8, borderRadius: 2 },
  seg: {
    flexDirection: "row",
    backgroundColor: "rgba(0,0,0,0.3)",
    borderRadius: 14,
    padding: 3,
    marginTop: 2,
  },
  segBtn: { flex: 1, height: 40, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  segOn: { backgroundColor: c.fg },
  segText: { color: c.fg2, fontSize: 13, fontWeight: "600" },
  segTextOn: { color: c.bg },
});
