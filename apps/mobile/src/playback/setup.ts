import TrackPlayer, { AppKilledPlaybackBehavior, Capability } from "react-native-track-player";

let ready: Promise<void> | undefined;

export function setupPlayer() {
  ready ??= (async () => {
    await TrackPlayer.setupPlayer();
    await TrackPlayer.updateOptions({
      capabilities: [Capability.Play, Capability.Pause, Capability.SkipToNext],
      android: { appKilledPlaybackBehavior: AppKilledPlaybackBehavior.StopPlaybackAndRemoveNotification },
    });
  })();
  return ready;
}
