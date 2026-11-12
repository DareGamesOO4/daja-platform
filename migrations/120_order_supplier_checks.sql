CREATE TABLE order_supplier_checks (
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL,
  link_id uuid NOT NULL,
  generation integer NOT NULL,
  provider_code text NOT NULL,
  url text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  checked_at timestamptz,
  result text,
  PRIMARY KEY (order_id, link_id)
);

CREATE INDEX order_supplier_checks_pending_idx ON order_supplier_checks (link_id, generation, requested_at)
  WHERE checked_at IS NULL;

CREATE INDEX email_deliveries_order_created_idx ON email_deliveries
  (organization_id, (split_part(deduplication_key, ':', 2)))
  WHERE tag IN ('order-confirmation', 'new-order-notification');

CREATE FUNCTION enqueue_order_supplier_checks(target_order uuid) RETURNS void LANGUAGE sql AS $$
  INSERT INTO order_supplier_checks (order_id, product_id, link_id, generation, provider_code, url)
  SELECT DISTINCT item.order_id, l.product_id, l.id, l.generation, l.provider_code, l.url
  FROM order_items item
  JOIN supplier_product_links l ON l.organization_id = item.organization_id AND l.product_id = item.product_id
  WHERE item.order_id = target_order AND NOT l.removed AND l.url IS NOT NULL
  ON CONFLICT DO NOTHING;
$$;

SELECT enqueue_order_supplier_checks(id) FROM orders
WHERE deleted_at IS NULL AND status IN ('Na čekanju', 'U obradi');
