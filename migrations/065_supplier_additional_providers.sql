INSERT INTO supplier_provider_checks (provider_code)
VALUES ('milano'), ('timezone'), ('qandq')
ON CONFLICT (provider_code) DO NOTHING;
