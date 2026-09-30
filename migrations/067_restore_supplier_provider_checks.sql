INSERT INTO supplier_provider_checks (provider_code)
VALUES ('ekka'), ('bultime'), ('linkel'), ('milano'), ('timezone'), ('qandq')
ON CONFLICT (provider_code) DO NOTHING;
