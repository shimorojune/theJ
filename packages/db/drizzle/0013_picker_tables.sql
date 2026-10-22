-- Precomputed so the picker's per-row checks are index lookups, not regexes (a mood start was
-- taking up to 30 s while the HNSW scan ran thej_is_cover on every row it passed).
CREATE TABLE IF NOT EXISTS song_skip (
  song_id text PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE
);--> statement-breakpoint
-- First credited artists with at least three songs, for Ask the DJ's artist matching.
CREATE TABLE IF NOT EXISTS artist_names (
  a text PRIMARY KEY,
  n integer NOT NULL
);--> statement-breakpoint
CREATE OR REPLACE FUNCTION thej_refresh_picker_tables() RETURNS void LANGUAGE sql AS $$
  DELETE FROM song_skip WHERE song_id NOT IN (
    SELECT id FROM songs WHERE thej_is_cover(title, artist));
  INSERT INTO song_skip (song_id)
    SELECT id FROM songs WHERE thej_is_cover(title, artist) ON CONFLICT DO NOTHING;
  DELETE FROM artist_names;
  INSERT INTO artist_names (a, n)
    SELECT lower(trim(split_part(artist, ',', 1))), count(*)::int FROM songs WHERE NOT junk
    GROUP BY 1 HAVING count(*) >= 3;
$$;--> statement-breakpoint
SELECT thej_refresh_picker_tables();
