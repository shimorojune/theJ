import type { Vibe } from "@thej/shared";
import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { type LayoutChangeEvent, Pressable, StyleSheet, Text, View } from "react-native";
import type { Queue } from "../lib/types";
import { c } from "../theme";

const clamp = (n: number) => Math.min(1, Math.max(0, n));
const word = (v: Vibe) =>
  `${v.energy > 0.66 ? "Hype" : v.energy > 0.33 ? "Warm" : "Chill"} · ${
    v.valence > 0.66 ? "bright" : v.valence > 0.33 ? "balanced" : "moody"
  }`;

/**
 * The mood pad (Control B): drag the white knob to where you want the music. Up is hype,
 * right is bright. The gold ring is where the music is now. Changes apply on the next song,
 * or now with the toggle.
 */
export function MoodPad({
  queue,
  onChange,
}: {
  queue: Queue;
  onChange: (vibe: Vibe, now: boolean) => void;
}) {
  const [size, setSize] = useState({ w: 1, h: 1 });
  const [drag, setDrag] = useState<Vibe | null>(null);
  const [now, setNow] = useState(false);
  const goal = drag ?? queue.goal;
  const lastHaptic = useRef(0);

  const place = (x: number, y: number) => ({
    valence: clamp(x / size.w),
    energy: clamp(1 - y / size.h),
  });
  const onLayout = (e: LayoutChangeEvent) =>
    setSize({ w: e.nativeEvent.layout.width || 1, h: e.nativeEvent.layout.height || 1 });

  return (
    <View style={st.card}>
      <View style={st.head}>
        <Text style={st.title}>{word(goal)}</Text>
        <View style={st.seg}>
          <Pressable onPress={() => setNow(false)} style={[st.segBtn, !now && st.segOn]}>
            <Text style={[st.segText, !now && st.segTextOn]}>Next song</Text>
          </Pressable>
          <Pressable onPress={() => setNow(true)} style={[st.segBtn, now && st.segOn]}>
            <Text style={[st.segText, now && st.segTextOn]}>Now</Text>
          </Pressable>
        </View>
      </View>
      <View
        onLayout={onLayout}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderGrant={(e) => {
          setDrag(place(e.nativeEvent.locationX, e.nativeEvent.locationY));
          void Haptics.selectionAsync();
        }}
        onResponderMove={(e) => {
          const v = place(e.nativeEvent.locationX, e.nativeEvent.locationY);
          setDrag(v);
          const t = Date.now();
          if (t - lastHaptic.current > 120) {
            lastHaptic.current = t;
            void Haptics.selectionAsync();
          }
        }}
        onResponderRelease={(e) => {
          const v = place(e.nativeEvent.locationX, e.nativeEvent.locationY);
          setDrag(null);
          void Haptics.impactAsync(
            now ? Haptics.ImpactFeedbackStyle.Heavy : Haptics.ImpactFeedbackStyle.Light,
          );
          onChange(v, now);
        }}
        onResponderTerminate={() => setDrag(null)}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={`Mood pad, now at ${word(goal)}. Up is hype, right is bright.`}
        style={st.pad}
      >
        <View style={[st.grid, { left: "50%", top: 0, bottom: 0, width: 1 }]} />
        <View style={[st.grid, { top: "50%", left: 0, right: 0, height: 1 }]} />
        <Text style={[st.corner, { left: 12, top: 10 }]}>Dark & loud</Text>
        <Text style={[st.corner, { right: 12, top: 10 }]}>Euphoric</Text>
        <Text style={[st.corner, { left: 12, bottom: 10 }]}>Late night</Text>
        <Text style={[st.corner, { right: 12, bottom: 10 }]}>Warm & easy</Text>
        <View
          pointerEvents="none"
          style={[
            st.nowRing,
            {
              left: queue.target.valence * size.w - 11,
              top: (1 - queue.target.energy) * size.h - 11,
            },
          ]}
        />
        <View
          pointerEvents="none"
          style={[
            st.knob,
            { left: goal.valence * size.w - 17, top: (1 - goal.energy) * size.h - 17 },
            drag && st.knobActive,
          ]}
        />
      </View>
      <Text style={st.hint}>White = where you want it · gold = where it is</Text>
    </View>
  );
}

const st = StyleSheet.create({
  card: { backgroundColor: c.card, borderRadius: 16, padding: 12, gap: 10 },
  head: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  title: { color: c.accent, fontSize: 13, fontWeight: "600" },
  seg: { flexDirection: "row", backgroundColor: "rgba(0,0,0,0.3)", borderRadius: 14, padding: 3 },
  segBtn: { height: 26, paddingHorizontal: 10, borderRadius: 13, justifyContent: "center" },
  segOn: { backgroundColor: c.fg },
  segText: { color: c.fg2, fontSize: 11, fontWeight: "600" },
  segTextOn: { color: c.bg },
  pad: {
    height: 220,
    borderRadius: 14,
    overflow: "hidden",
    backgroundColor: "#1E1A24",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  grid: { position: "absolute", backgroundColor: "rgba(255,255,255,0.08)" },
  corner: { position: "absolute", color: c.fg2, fontSize: 11 },
  nowRing: {
    position: "absolute",
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: c.accent,
  },
  knob: {
    position: "absolute",
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: c.fg,
    borderWidth: 3,
    borderColor: c.bg,
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 8,
    elevation: 6,
  },
  knobActive: { transform: [{ scale: 1.15 }] },
  hint: { color: c.faint, fontSize: 11, textAlign: "center" },
});
