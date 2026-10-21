import { useAuth, useUser } from "@clerk/expo";
import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { c } from "../src/theme";

/** Signed out → sign in. First run → onboarding. Otherwise home. */
export default function Index() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  if (!isLoaded) {
    return (
      <View style={{ flex: 1, backgroundColor: c.bg, justifyContent: "center" }}>
        <ActivityIndicator color={c.fg} />
      </View>
    );
  }
  if (!isSignedIn) return <Redirect href="/sign-in" />;
  const onboarded = Boolean(user?.unsafeMetadata?.onboarded);
  return <Redirect href={onboarded ? "/home" : "/onboarding/languages"} />;
}
