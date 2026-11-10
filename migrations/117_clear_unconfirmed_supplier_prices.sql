-- Historical observations can contain a promotion price. Keep availability
-- and scheduling data while each provider's ordinary checks refresh prices.
UPDATE supplier_product_links
SET price_amount = NULL,
    price_currency = NULL,
    last_good_result = last_good_result - 'priceAmount' - 'priceCurrency'
WHERE price_amount IS NOT NULL
   OR price_currency IS NOT NULL
   OR last_good_result ?| ARRAY['priceAmount', 'priceCurrency'];
