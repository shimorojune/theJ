import { Pressable, StyleSheet, Text, View } from "react-native";
import type { LanguageChoice } from "../lib/prefs";
import { c } from "../theme";
import { tap } from "./kit";

/** Which language leads a mixed set, as the Hindi share of songs the picker keeps to. */
const LEADS = [
  { id: "hi", label: "Hindi", share: 0.75, line: "About 3 in every 4 songs in Hindi" },
  { id: "even", label: "Equal", share: 0.5, line: "Hindi and English take turns" },
  { id: "en", label: "English", share: 0.25, line: "About 3 in every 4 songs in English" },
] as const;

/** The lead closest to a saved share (older builds saved any tenth from 0.1 to 0.9). */
const leadFor = (share: number) => (share > 0.6 ? LEADS[0] : share < 0.4 ? LEADS[2] : LEADS[1]);

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
  const lead = leadFor(props.hiShare);
  return (
    <View style={{ gap: 10 }}>
      {OPTIONS.map((o) => {
        const on = props.choice === o.id;
        return (
          <Pressable
            key={o.id}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            onPressIn={tap}
            onPress={() => props.onChoice(o.id)}
            style={({ pressed }) => [
              st.option,
              { borderColor: on ? c.accent : c.surface },
              pressed && { opacity: 0.75 },
            ]}
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
          <Text style={st.label}>Which language leads?</Text>
          <View style={st.seg} accessibilityRole="radiogroup">
            {LEADS.map((l) => {
              const on = lead.id === l.id;
              return (
                <Pressable
                  key={l.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${l.label}. ${l.line}`}
                  onPressIn={tap}
                  onPress={() => props.onHiShare(l.share)}
                  style={({ pressed }) => [st.segBtn, on && st.segOn, pressed && { opacity: 0.7 }]}
                >
                  <Text style={[st.segText, on && st.segTextOn]}>{l.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={st.hint}>{lead.line}</Text>
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
    padding: 16,
    gap: 12,
  },
  seg: { flexDirection: "row", backgroundColor: "rgba(0,0,0,0.35)", borderRadius: 12, padding: 3 },
  segBtn: { flex: 1, height: 42, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  segOn: { backgroundColor: c.accent },
  segText: { color: c.fg2, fontSize: 14, fontWeight: "600" },
  segTextOn: { color: c.bg },
});
