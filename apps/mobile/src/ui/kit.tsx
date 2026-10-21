import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import type { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  type StyleProp,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { c } from "../theme";

export function Screen({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <SafeAreaView style={[s.screen, style]} edges={["top", "bottom"]}>
      {children}
    </SafeAreaView>
  );
}

export function PrimaryButton(props: {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      disabled={props.disabled || props.busy}
      style={({ pressed }) => [s.primary, (pressed || props.disabled) && { opacity: 0.7 }]}
    >
      {props.busy ? (
        <ActivityIndicator color={c.bg} />
      ) : (
        <Text style={s.primaryText}>{props.label}</Text>
      )}
    </Pressable>
  );
}

export function GhostButton(props: { label: string; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" onPress={props.onPress} style={s.ghost}>
      <Text style={s.ghostText}>{props.label}</Text>
    </Pressable>
  );
}

export function IconButton(props: {
  name: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress?: () => void;
  size?: number;
  color?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      hitSlop={8}
      style={s.icon}
    >
      <Ionicons name={props.name} size={props.size ?? 22} color={props.color ?? c.fg} />
    </Pressable>
  );
}

/** Back arrow plus the onboarding progress bar ("1 of 2"). */
export function StepBar({ step, of }: { step: number; of: number }) {
  return (
    <View style={s.stepBar}>
      <IconButton name="chevron-back" label="Back" onPress={() => router.back()} />
      <View style={s.steps}>
        {Array.from({ length: of }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length progress segments
          <View key={i} style={[s.step, { backgroundColor: i < step ? c.fg : c.line }]} />
        ))}
      </View>
      <Text style={s.stepText}>
        {step} of {of}
      </Text>
    </View>
  );
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: c.bg, paddingHorizontal: 24 },
  h1: { color: c.fg, fontSize: 28, fontWeight: "600", letterSpacing: -0.7, lineHeight: 32 },
  lede: { color: c.muted, fontSize: 15, lineHeight: 22 },
  primary: {
    height: 52,
    borderRadius: 26,
    backgroundColor: c.fg,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { color: c.bg, fontSize: 15, fontWeight: "500" },
  ghost: { height: 48, alignItems: "center", justifyContent: "center" },
  ghostText: { color: c.muted, fontSize: 14 },
  icon: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  stepBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    height: 44,
    marginTop: 6,
    marginLeft: -12,
  },
  steps: { flex: 1, flexDirection: "row", gap: 6 },
  step: { flex: 1, height: 3, borderRadius: 2 },
  stepText: { color: c.dim, fontSize: 13 },
});
