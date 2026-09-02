-- Both views of a lead's homepage, kept as files rather than as Apify links.
--
-- `shot` holds the laptop picture and stays. This holds the pair — laptop and
-- phone — each carrying the StoredFile ids the bytes were kept in: the top of
-- the page the model read, and the whole page beside it. An Apify key-value
-- store link expires with the run's data, so before this a lead's screenshot
-- was a broken image a few days after it was taken.
ALTER TABLE "LeadResearch" ADD COLUMN "shots" JSONB;
