-- Keep existing records untouched during rollout, while rejecting every new
-- or updated EPC that is not a whole-byte hexadecimal identifier.
ALTER TABLE rfid_tags
  ADD CONSTRAINT rfid_tags_epc_even_length_check
  CHECK (length(epc) % 2 = 0) NOT VALID;
