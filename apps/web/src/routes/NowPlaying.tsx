// Now playing (design canvas: Main.dc.html, direction A). Wired up in build step 3.
export function NowPlaying() {
  return (
    <main className="screen">
      <div className="center">
        <p className="muted">Nothing playing yet</p>
      </div>
      <section className="card" aria-label="Vibe">
        <strong>Vibe</strong>
      </section>
    </main>
  );
}
