-- Karaoke, tribute and compilation-act recordings of other people's songs: never picked.
CREATE OR REPLACE FUNCTION thej_is_cover(title text, artist text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(title, '') ~* '(made popular by|in the style of|originally performed|as made famous|\m(vocal|instrumental|karaoke) version\M|karaoke|tribute to)'
      OR coalesce(artist, '') ~* '(karaoke|tribute|\mcovers?\M|cover band|made famous|\mhits (19|20)\d\d\M|dance hits|dance fruits|party hits|chart hits|top hits|hit crew|workout|fitness|string quartet|vitamin string|piano (tribute|covers)|lullaby|8-bit|ringtone|nightcore|sped up|countdown singers|session musicians|studio (musicians|allstars)|music factory|the hit factory|graham blvd|starlite|ameritz)'
$$;
