-- Website controls use Serbian labels with Š/Ž. Normalize values written by
-- older RFID desktop clients so those controls and every sync snapshot use
-- the same canonical catalog value.
BEGIN;

UPDATE product_variants
SET gender = CASE upper(translate(gender, 'ŠšŽž', 'SsZz'))
  WHEN 'MUSKI' THEN 'MUŠKI'
  WHEN 'ZENSKI' THEN 'ŽENSKI'
  WHEN 'UNISEX' THEN 'Unisex'
  ELSE gender
END,
    updated_at = now(),
    version = version + 1
WHERE gender IS NOT NULL
  AND upper(translate(gender, 'ŠšŽž', 'SsZz')) IN ('MUSKI', 'ZENSKI', 'UNISEX');

COMMIT;
