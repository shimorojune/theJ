-- Language of untagged songs, inferred from their playlist labels and their artist (rebuilt by
-- thej_refresh_song_langs(): here once, then by the catalogue job). Kept out of `songs` so a
-- refresh never rewrites the songs table or its HNSW index.
CREATE TABLE IF NOT EXISTS song_langs (
  song_id text PRIMARY KEY REFERENCES songs(id) ON DELETE CASCADE,
  langs text[] NOT NULL
);--> statement-breakpoint
-- Language named by a song's playlist/genre labels ("desi hip-hop", "indian indie", "tamil").
-- Regional names win over the generic Indian ones, which mean Hindi.
CREATE OR REPLACE FUNCTION thej_label_lang(labels text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (CASE
    WHEN l ~* '\mbhojpuri\M' THEN '{bho}'
    WHEN l ~* '\mharyanvi\M' THEN '{bgc}'
    WHEN l ~* '\m(punjabi|bhangra)\M' THEN '{pa}'
    WHEN l ~* '\m(tamil|kollywood)\M' THEN '{ta}'
    WHEN l ~* '\m(telugu|tollywood)\M' THEN '{te}'
    WHEN l ~* '\m(malayalam|mollywood)\M' THEN '{ml}'
    WHEN l ~* '\m(kannada|sandalwood)\M' THEN '{kn}'
    WHEN l ~* '\mmarathi\M' THEN '{mr}'
    WHEN l ~* '\m(bengali|bangla)\M' THEN '{bn}'
    WHEN l ~* '\m(gujarati|garba)\M' THEN '{gu}'
    WHEN l ~* '\mk-?pop\M' THEN '{ko}'
    WHEN l ~* '\m(latin|latino|reggaeton)\M' THEN '{es}'
    WHEN l ~* '(desi|indian|\mindia\M|bolly|hindi|filmi|sufi|ghazal|qawwali|indipop)' THEN '{hi}'
  END)::text[]
  FROM (SELECT array_to_string(labels, ' ') AS l) x
$$;--> statement-breakpoint
-- Untagged songs: the labels' language, else their first artist's (the language of most of the
-- artist's songs whose language is known, if at least two and 60% agree). Tagged songs are
-- read from their tag directly.
CREATE OR REPLACE FUNCTION thej_refresh_song_langs() RETURNS void LANGUAGE sql AS $$
  WITH base AS (
    SELECT id, lower(trim(split_part(artist, ',', 1))) AS a, languages, lang_guess,
           thej_label_lang(labels) AS lab
    FROM songs
  ),
  known AS (
    SELECT id, a, coalesce(
      CASE WHEN lang_guess && '{bho,bgc}'::text[] THEN lang_guess END,
      CASE WHEN languages && '{bh}'::text[] THEN '{bho}'::text[] END,
      nullif(languages, '{}'::text[]),
      lab) AS langs
    FROM base
  ),
  votes AS (
    SELECT a, langs[1] AS l, count(*) AS n FROM known WHERE langs IS NOT NULL GROUP BY 1, 2
  ),
  best AS (
    SELECT DISTINCT ON (a) a, l, n, sum(n) OVER (PARTITION BY a) AS total
    FROM votes ORDER BY a, n DESC
  ),
  inferred AS (
    SELECT b.id, coalesce(b.lab, CASE WHEN v.n >= 2 AND v.n >= 0.6 * v.total THEN ARRAY[v.l] END) AS langs
    FROM base b LEFT JOIN best v ON v.a = b.a
    WHERE b.languages = '{}'::text[]
  ),
  gone AS (
    DELETE FROM song_langs WHERE song_id NOT IN (SELECT id FROM inferred WHERE langs IS NOT NULL)
  )
  INSERT INTO song_langs (song_id, langs)
  SELECT id, langs FROM inferred WHERE langs IS NOT NULL
  ON CONFLICT (song_id) DO UPDATE SET langs = excluded.langs
$$;--> statement-breakpoint
SELECT thej_refresh_song_langs();
