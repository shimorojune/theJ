import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LanguageChoice } from "../lib/prefs";
import { c } from "../theme";

const OPTIONS: { id: LanguageChoice; label: string; hint: string; c1: string; c2: string }[] = [
  { id: "en", label: "English", hint: "Pop, hip-hop, dance, indie", c1: "#46629E", c2: "#6E5BB0" },
  { id: "hi", label: "Hindi", hint: "Bollywood, indie, Punjabi", c1: "#B8754A", c2: "#B5607A" },
  {
    id: "mix",
    label: "English + Hindi",
    hint: "Both, blended through the night",
    c1: "#B8754A",
    c2: "#46629E",
  },
];

export function LanguagePicker(props: {
  choice: LanguageChoice;
  hiShare: number;
  onChoice: (c: LanguageChoice) => void;
  onHiShare: (n: number) => void;
}) {
  const pct = Math.round(props.hiShare * 100);
  return (
    <View style={{ gap: 10 }}>
      {OPTIONS.map((o) => {
        const on = props.choice === o.id;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPress={() => props.onChoice(o.id)}
            style={[st.option, { borderColor: on ? c.accent : c.surface }]}
          >
            <View style={st.swatch}>
              <View style={[st.sq, { left: 0, backgroundColor: o.c1 }]} />
              <View style={[st.sq, { left: 16, backgroundColor: o.c2 }]} />
            </View>
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={st.label}>{o.label}</Text>
              <Text style={st.hint}>{o.hint}</Text>
            </View>
            <View style={on ? st.dotOn : st.dotOff} />
          </Pressable>
        );
      })}
      <View style={[st.option, st.soon]}>
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[st.label, { color: "#63636A" }]}>Japanese</Text>
          <Text style={[st.hint, { color: "#63636A" }]}>J-pop, city pop, anime</Text>
        </View>
        <Text style={{ color: "#63636A", fontSize: 12 }}>Coming soon</Text>
      </View>
      {props.choice === "mix" ? (
        <View style={st.mix}>
          <View style={st.mixRow}>
            <Text style={st.hint}>Hindi {pct}%</Text>
            <Text style={st.hint}>English {100 - pct}%</Text>
          </View>
          <View style={st.mixRow}>
            <Pressable
              accessibilityLabel="More Hindi"
              hitSlop={8}
              onPress={() => props.onHiShare(Math.min(0.9, props.hiShare + 0.1))}
              style={st.step}
            >
              <Text style={st.stepText}>−</Text>
            </Pressable>
            <View style={st.track}>
              <View style={[st.fill, { width: `${pct}%` }]} />
            </View>
            <Pressable
              accessibilityLabel="More English"
              hitSlop={8}
              onPress={() => props.onHiShare(Math.max(0.1, props.hiShare - 0.1))}
              style={st.step}
            >
              <Text style={st.stepText}>+</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const st = StyleSheet.create({
  option: {
    minHeight: 72,
    borderRadius: 12,
    paddingHorizontal: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    backgroundColor: c.surface,
    borderWidth: 1.5,
  },
  soon: {
    backgroundColor: "transparent",
    borderColor: c.line,
    borderStyle: "dashed",
    borderWidth: 1,
  },
  swatch: { width: 52, height: 36 },
  sq: { position: "absolute", top: 0, width: 36, height: 36, borderRadius: 4 },
  label: { color: c.fg, fontSize: 16, fontWeight: "500" },
  hint: { color: c.dim, fontSize: 13 },
  dotOn: { width: 20, height: 20, borderRadius: 10, borderWidth: 6, borderColor: c.accent },
  dotOff: { width: 20, height: 20, borderRadius: 10, borderWidth: 1.5, borderColor: "#4A4A50" },
  mix: {
    marginTop: 10,
    backgroundColor: c.surface,
    borderRadius: 12,
    paddingVertical: 10,
    paddingHorizontal: 16,
    gap: 4,
  },
  mixRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  step: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  stepText: { color: c.fg, fontSize: 20 },
  track: { flex: 1, height: 3, borderRadius: 2, backgroundColor: c.track, marginHorizontal: 6 },
  fill: { height: 3, borderRadius: 2, backgroundColor: c.accent },
});
