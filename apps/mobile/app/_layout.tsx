import { ClerkProvider, useAuth } from "@clerk/expo";
import { tokenCache } from "@clerk/expo/token-cache";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import type { ReactNode } from "react";
import { PartyProvider } from "../src/party/PartyProvider";
import { c } from "../src/theme";

const queryClient = new QueryClient();
const publishableKey = process.env.EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY ?? "";

/** The party (and its audio) only exists for a signed-in user. */
function WhenSignedIn({ children }: { children: ReactNode }) {
  const { isSignedIn } = useAuth();
  return isSignedIn ? <PartyProvider>{children}</PartyProvider> : children;
}

export default function RootLayout() {
  return (
    <ClerkProvider publishableKey={publishableKey} tokenCache={tokenCache}>
      <QueryClientProvider client={queryClient}>
        <WhenSignedIn>
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: c.bg },
              animation: "fade",
            }}
          >
            <Stack.Screen name="player" options={{ animation: "slide_from_bottom" }} />
            <Stack.Screen name="queue" options={{ animation: "slide_from_bottom" }} />
          </Stack>
        </WhenSignedIn>
      </QueryClientProvider>
    </ClerkProvider>
  );
}
