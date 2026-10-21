import { Pressable, StyleSheet, Text, View } from "react-native";
import { c, VIBES } from "../theme";

export type VibeId = (typeof VIBES)[number]["id"];

export function VibeTiles(props: {
  picked?: VibeId;
  onPick: (id: VibeId) => void;
  compact?: boolean;
}) {
  const list = props.compact ? VIBES.slice(0, 4) : VIBES;
  return (
    <View style={st.grid}>
      {list.map((t) => {
        const on = props.picked === t.id;
        return (
          <Pressable
            key={t.id}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            onPress={() => props.onPick(t.id)}
            style={[
              props.compact ? st.small : st.tile,
              { backgroundColor: t.bg },
              on && { borderWidth: 2, borderColor: c.fg },
            ]}
          >
            <View style={st.row}>
              <Text style={props.compact ? st.smallLabel : st.label}>{t.label}</Text>
              {on && !props.compact ? <View style={st.check} /> : null}
            </View>
            {props.compact ? null : <Text style={st.hint}>{t.hint}</Text>}
          </Pressable>
        );
      })}
    </View>
  );
}

const st = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  tile: {
    width: "48%",
    height: 92,
    borderRadius: 10,
    padding: 14,
    justifyContent: "space-between",
  },
  small: { width: "22.5%", height: 64, borderRadius: 10, padding: 10, justifyContent: "flex-end" },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" },
  label: { color: c.fg, fontSize: 16, fontWeight: "600" },
  smallLabel: { color: c.fg, fontSize: 12, fontWeight: "600" },
  hint: { color: "rgba(255,255,255,0.72)", fontSize: 12 },
  check: { width: 18, height: 18, borderRadius: 9, backgroundColor: c.fg },
});
