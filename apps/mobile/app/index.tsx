import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useSession } from "../src/lib/auth";
import { c } from "../src/theme";

/** Signed out → sign in. First run → onboarding. Otherwise home. */
export default function Index() {
  const { isLoaded, isSignedIn, onboarded } = useSession();
  if (!isLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: "center" }}>
        <ActivityIndicator color={c.fg} />
      </View>
    );
  }
  if (!isSignedIn) return <Redirect href="/sign-in" />;
  return <Redirect href={onboarded ? "/home" : "/onboarding/languages"} />;
}
