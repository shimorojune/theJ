-- Typo-tolerant artist matching for Ask the DJ (levenshtein).
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;--> statement-breakpoint
-- A title that is a video upload or a re-edit rather than the song itself.
CREATE OR REPLACE FUNCTION thej_is_junk(title text) RETURNS boolean
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(title, '') ~* '(#|\mhd\M|\m4k\M|full video|video song|\mlo-?fi\M|slowed|reverb|mashup|jukebox|non-?stop|8d audio|\mstatus\M|ringtone|karaoke|whatsapp|\mshorts\M)'
$$;--> statement-breakpoint
-- Language from playlist labels and script, for songs the LLM tagger has not reached yet.
CREATE OR REPLACE FUNCTION thej_guess_languages(title text, artist text, labels text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT (CASE
    WHEN labels && '{bhojpuri}'::text[] OR (title || ' ' || artist) ~* '(bhojpuri|khesari|pawan singh|nirahua|dinesh lal|shilpi raj|ritesh pandey|arvind akela)' THEN '{bho}'
    WHEN labels && '{haryanvi}'::text[] OR (title || ' ' || artist) ~* '(haryanvi|masoom sharma|sapna choudhary)' THEN '{bgc}'
    WHEN labels && '{punjabi,bhangra}'::text[] THEN '{pa}'
    WHEN labels && '{tamil,kollywood}'::text[] OR (title || artist) ~ '[஀-௿]' THEN '{ta}'
    WHEN labels && '{telugu,tollywood}'::text[] OR (title || artist) ~ '[ఀ-౿]' THEN '{te}'
    WHEN labels && '{malayalam,mollywood}'::text[] OR (title || artist) ~ '[ഀ-ൿ]' THEN '{ml}'
    WHEN labels && '{kannada,sandalwood}'::text[] OR (title || artist) ~ '[ಀ-೿]' THEN '{kn}'
    WHEN labels && '{marathi}'::text[] THEN '{mr}'
    WHEN labels && '{bengali,bangla}'::text[] OR (title || artist) ~ '[ঀ-৿]' THEN '{bn}'
    WHEN labels && '{gujarati,garba}'::text[] OR (title || artist) ~ '[઀-૿]' THEN '{gu}'
    WHEN labels && '{k-pop,kpop}'::text[] OR (title || artist) ~ '[가-힯]' THEN '{ko}'
    WHEN labels && '{latin,reggaeton}'::text[] THEN '{es}'
    WHEN (title || artist) ~ '[ऀ-ॿ]' THEN '{hi}'
    WHEN labels && '{bollywood,hindi,filmi,desi,sufi,ghazal,indipop,qawwali}'::text[] THEN '{hi}'
    -- Romanised Hindi: common Hindi words in the title.
    WHEN title ~* '\m(hai|hain|mein|tum|tera|teri|tere|mera|meri|mere|dil|pyaar|pyar|ishq|yaar|kya|nahi|nahin|hum|jaana|sanam|mohabbat|zindagi|kahin|saath|raat|raaton|aaja|jaaye|soniye|mahi|channa|sajna|dilbar|naina|aankhein|tujhe|mujhe|kuch|kabhi|abhi|bheegi|baarish|deewana|deewani|ladki|munda|kudi|nachle|balle|gori|chadheya|jaan|tujh|tumhe|tumse|humko|hamari|tumhari|mausam|bahaar|sapne|khwab|dhadkan|jiya|piya|saiyaan|sajan|balam)\M' THEN '{hi}'
    WHEN (title || ' ' || artist) ~ '^[ -~À-ɏ‘-‟–—]*$' THEN '{en}'
    ELSE '{}'
  END)::text[]
$$;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "artists" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "songs" ADD COLUMN "lang_guess" text[] GENERATED ALWAYS AS (thej_guess_languages(title, artist, labels)) STORED NOT NULL;--> statement-breakpoint
ALTER TABLE "songs" ADD COLUMN "junk" boolean GENERATED ALWAYS AS (thej_is_junk(title)) STORED NOT NULL;