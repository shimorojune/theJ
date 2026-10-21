import { Show } from "@clerk/react";
import { Route, Routes } from "react-router";
import { NowPlaying } from "./routes/NowPlaying";
import { SignIn } from "./routes/SignIn";

export function App() {
  return (
    <>
      <Show when="signed-out">
        <SignIn />
      </Show>
      <Show when="signed-in">
        <Routes>
          <Route path="/" element={<NowPlaying />} />
        </Routes>
      </Show>
    </>
  );
}
