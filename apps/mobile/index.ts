import TrackPlayer from "react-native-track-player";
import { PlaybackService } from "./src/playback/service";

// RNTP's background service must be registered before the app renders.
TrackPlayer.registerPlaybackService(() => PlaybackService);

import "expo-router/entry";
