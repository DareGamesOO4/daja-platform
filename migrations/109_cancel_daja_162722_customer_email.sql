BEGIN;

ALTER TABLE orders ADD COLUMN customer_email_disabled boolean NOT NULL DEFAULT false;

UPDATE orders
SET customer_email_disabled = true
WHERE display_id = 'DAJA-162722'
  AND created_at >= '2026-11-08 21:19:00+00'
  AND created_at < '2026-11-08 21:20:00+00';

UPDATE email_deliveries AS delivery
SET status = 'suppressed', retryable = false, locked_until = NULL,
    payload = '{}'::jsonb, last_error = 'Cancelled at the store operator request'
FROM orders AS customer_order
WHERE customer_order.display_id = 'DAJA-162722'
  AND customer_order.created_at >= '2026-11-08 21:19:00+00'
  AND customer_order.created_at < '2026-11-08 21:20:00+00'
  AND (
    (delivery.tag = 'order-confirmation'
      AND delivery.deduplication_key = 'order-created:' || customer_order.id::text || ':customer:' || delivery.recipient)
    OR (delivery.tag = 'order-status-update'
      AND delivery.deduplication_key LIKE 'order-status:' || customer_order.id::text || ':%')
  )
  AND delivery.status IN ('pending', 'failed');

UPDATE email_deliveries AS delivery
SET expires_at = GREATEST(delivery.expires_at, now() + interval '30 days')
FROM orders AS customer_order
WHERE customer_order.display_id = 'DAJA-162722'
  AND customer_order.created_at >= '2026-11-08 21:19:00+00'
  AND customer_order.created_at < '2026-11-08 21:20:00+00'
  AND delivery.deduplication_key = 'order-created:' || customer_order.id::text || ':admin:' || delivery.recipient
  AND delivery.tag = 'new-order-notification'
  AND delivery.status = 'pending';

COMMIT;
