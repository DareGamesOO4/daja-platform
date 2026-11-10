-- Discard the reported stale promotion price and use the existing manual
-- queue to refresh the exact supplier URL without moving its regular slot.
UPDATE supplier_product_links
SET price_amount = NULL,
    price_currency = NULL,
    last_good_result = last_good_result - 'priceAmount' - 'priceCurrency' - 'regularPrice',
    manual_requested_at = CASE
      WHEN checks_enabled THEN COALESCE(manual_requested_at, now())
      ELSE manual_requested_at
    END
WHERE provider_code = 'timezone'
  AND NOT removed
  AND split_part(split_part(url, '?', 1), '#', 1) ~ '^https://(www\.)?timezone-bg\.com/product/mazhki-chasovnik-qq-al08j582y/?$';
