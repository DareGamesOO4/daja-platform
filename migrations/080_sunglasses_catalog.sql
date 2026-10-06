-- Sunglasses only. Other departments and their grouping rules are unchanged.
CREATE OR REPLACE FUNCTION catalog_eyewear_group_key(product_name text, department_slug text, brand_id text)
RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN department_slug='naocare' AND model IS NOT NULL
    THEN 'naocare:' || COALESCE(brand_id,'') || ':' || model ELSE NULL END
  FROM (SELECT (regexp_match(upper(product_name), '(?:^|[^A-Z0-9])([A-Z]{0,8}[0-9]{3,}[A-Z]?)(?=[[:space:]-]|$)'))[1] AS model) m;
$$;

DO $seed$
DECLARE
  d record;
  item jsonb;
  spec_id uuid;
  fields jsonb;
  config jsonb;
  filters jsonb;
  node jsonb;
  published_config jsonb;
  draft_config jsonb;
  next_revision integer;
  seeds jsonb := $json$[
    {"slug":"oblik-okvira","name":"Oblik okvira","group":"eyewear-frame","options":["Pravougaoni","Kvadratni","Okrugli","Ovalni","Pilot (Aviator)","Navigator","Wayfarer","Mačkasti (Cat Eye)","Geometrijski","Vizir (Shield)","Browline","Sportski"]},
    {"slug":"materijal-okvira","name":"Materijal okvira","group":"eyewear-frame","options":["Metal","Plastika","Acetat","TR","Titanijum","Kombinovani"]},
    {"slug":"boja-okvira","name":"Boja okvira","group":"eyewear-frame","options":["Crna","Braon","Zlatna","Srebrna","Tamnosiva metalik (Gunmetal)","Siva","Bela","Plava","Crvena","Zelena","Roze","Ljubičasta","Narandžasta","Žuta","Providna","Višebojna"]},
    {"slug":"konstrukcija-okvira","name":"Konstrukcija okvira","group":"eyewear-frame","options":["Puni okvir","Poluokvir","Bez okvira"]},
    {"slug":"zavrsna-obrada-okvira","name":"Završna obrada okvira","group":"eyewear-frame","options":["Mat","Sjajna","Kombinovana"]},
    {"slug":"boja-sociva","name":"Boja sočiva","group":"eyewear-lenses","options":["Crna","Braon","Siva","Zelena","Plava","Ljubičasta","Crvena","Žuta","Narandžasta","Roze","Bela","Providna","Višebojna"]},
    {"slug":"polarizacija","name":"Polarizacija","group":"eyewear-lenses","options":["Da","Ne"]},
    {"slug":"uv400-zastita","name":"UV400 zaštita","group":"eyewear-lenses","options":["Da","Ne"]},
    {"slug":"ogledalska-sociva","name":"Ogledalska sočiva","group":"eyewear-lenses","options":["Da","Ne"]},
    {"slug":"gradijentna-sociva","name":"Gradijentna sočiva","group":"eyewear-lenses","options":["Da","Ne"]},
    {"slug":"materijal-sociva","name":"Materijal sočiva","group":"eyewear-lenses","options":["Polikarbonat","Najlon","CR-39","Mineralno staklo"]},
    {"slug":"kategorija-filtera-sociva","name":"Kategorija filtera sočiva","group":"eyewear-lenses","options":["0","1","2","3","4"]},
    {"slug":"sirina-sociva","name":"Širina sočiva","group":"eyewear-dimensions","unit":"mm","options":[]},
    {"slug":"sirina-mosta","name":"Širina mosta","group":"eyewear-dimensions","unit":"mm","options":[]},
    {"slug":"duzina-drske","name":"Dužina drške","group":"eyewear-dimensions","unit":"mm","options":[]},
    {"slug":"uzrasna-grupa-naocara","name":"Uzrasna grupa","group":"eyewear-extra","options":["Odrasli","Deca"]},
    {"slug":"pakovanje-naocara","name":"Pakovanje","group":"eyewear-extra","options":["Futrola","Vrećica","Krpica","Futrola i krpica","Vrećica i krpica","Futrola, vrećica i krpica"]},
    {"slug":"milano-sifra","name":"Milano šifra","group":"eyewear-extra","options":[]}
  ]$json$::jsonb;
  groups jsonb := '[{"id":"eyewear-frame","name":"Okvir"},{"id":"eyewear-lenses","name":"Sočiva i zaštita"},{"id":"eyewear-dimensions","name":"Dimenzije"},{"id":"eyewear-extra","name":"Dodatno"}]';
BEGIN
  FOR d IN SELECT id,organization_id FROM departments WHERE slug='naocare' AND deleted_at IS NULL LOOP
    fields := '[]';
    FOR item IN SELECT value FROM jsonb_array_elements(seeds) LOOP
      INSERT INTO spec_keys (organization_id,department_id,department,name,slug,unit,option_values)
      VALUES(d.organization_id,d.id,'naocare',item->>'name',item->>'slug',item->>'unit',item->'options')
      ON CONFLICT (organization_id,slug) WHERE deleted_at IS NULL DO NOTHING;
      SELECT id INTO spec_id FROM spec_keys WHERE organization_id=d.organization_id
        AND department_id=d.id AND slug=item->>'slug' AND deleted_at IS NULL;
      IF spec_id IS NULL THEN RAISE EXCEPTION 'Specification slug belongs to another department: %',item->>'slug'; END IF;
      -- Preserve additional answers already entered by the owner.
      UPDATE spec_keys SET option_values=(SELECT jsonb_agg(value ORDER BY first_pos) FROM (
        SELECT value,min(pos) AS first_pos FROM jsonb_array_elements(option_values || (item->'options')) WITH ORDINALITY e(value,pos) GROUP BY value
      ) merged), version=version+1,updated_at=now()
      WHERE id=spec_id AND jsonb_array_length(item->'options')>0;
      fields := fields || jsonb_build_array(jsonb_build_object('specId',spec_id,'groupId',item->>'group','order',jsonb_array_length(fields),'visibility','[]'::jsonb,'options','[]'::jsonb));
    END LOOP;
    SELECT configuration INTO config FROM specification_editor_configurations WHERE organization_id=d.organization_id AND department_id=d.id;
    IF config IS NULL THEN config := jsonb_build_object('groups',groups,'fields',fields);
    ELSE
      config := jsonb_set(config,'{groups}',COALESCE(config->'groups','[]') || COALESCE((SELECT jsonb_agg(g) FROM jsonb_array_elements(groups) g WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config->'groups') old WHERE old->>'id'=g->>'id')),'[]'));
      config := jsonb_set(config,'{fields}',COALESCE(config->'fields','[]') || COALESCE((SELECT jsonb_agg(f) FROM jsonb_array_elements(fields) f WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(config->'fields') old WHERE old->>'specId'=f->>'specId')),'[]'));
    END IF;
    INSERT INTO specification_editor_configurations(organization_id,department_id,configuration)
    VALUES(d.organization_id,d.id,config) ON CONFLICT(organization_id,department_id) DO UPDATE SET configuration=EXCLUDED.configuration,version=specification_editor_configurations.version+1,updated_at=now();

    filters := '[]';
    FOR item IN SELECT value FROM jsonb_array_elements('[
      {"source":"brand","name":"Brend"},{"source":"gender","name":"Pol","options":["Muški","Ženski"]},
      {"source":"price","name":"Cena","style":"range","unit":"RSD"},
      {"source":"spec:oblik_okvira","name":"Oblik okvira"},
      {"source":"spec:polarizacija","name":"Polarizacija"},
      {"source":"spec:materijal_okvira","name":"Materijal okvira"},
      {"source":"spec:boja_okvira","name":"Boja okvira","style":"color"},
      {"source":"spec:boja_sociva","name":"Boja sočiva","style":"color"},
      {"source":"spec:uv400_zastita","name":"UV400 zaštita"},
      {"source":"spec:ogledalska_sociva","name":"Ogledalska sočiva"},
      {"source":"spec:gradijentna_sociva","name":"Gradijentna sočiva"},
      {"source":"spec:uzrasna_grupa_naocara","name":"Uzrasna grupa"},
      {"source":"spec:sirina_sociva","name":"Širina sočiva","style":"range","unit":"mm"},
      {"source":"spec:sirina_mosta","name":"Širina mosta","style":"range","unit":"mm"},
      {"source":"spec:duzina_drske","name":"Dužina drške","style":"range","unit":"mm"},
      {"source":"spec:konstrukcija_okvira","name":"Konstrukcija okvira"},
      {"source":"spec:zavrsna_obrada_okvira","name":"Završna obrada okvira"},
      {"source":"spec:materijal_sociva","name":"Materijal sočiva"},
      {"source":"spec:kategorija_filtera_sociva","name":"Kategorija filtera sočiva"}
    ]'::jsonb) LOOP
      node := jsonb_build_object('id',gen_random_uuid(),'title',item->>'name','description','','visible',true,'open',jsonb_array_length(filters)<3,'priority',jsonb_array_length(filters),'mode','options','style',COALESCE(item->>'style','checkbox'),'match','any','columns',CASE WHEN item->>'style'='color' THEN 5 ELSE 1 END,'showCounts',COALESCE(item->>'style','')<>'color','unit',COALESCE(item->>'unit',''),'sources',jsonb_build_array(item->>'source'),'autoAddOptions',true,'children','[]'::jsonb,'options','[]'::jsonb);
      IF item->>'source'='gender' THEN
        node := jsonb_set(node,'{options}',(SELECT jsonb_agg(jsonb_build_object('id',gen_random_uuid(),'label',v,'visible',true,'color','','image','','conditions',jsonb_build_array(jsonb_build_object('source','gender','values',jsonb_build_array(v))))) FROM jsonb_array_elements_text(item->'options') v));
      END IF;
      filters := filters || jsonb_build_array(node);
    END LOOP;
    SELECT published,draft,revision+1 INTO published_config,draft_config,next_revision FROM catalog_filter_configurations WHERE organization_id=d.organization_id AND department='naocare';
    published_config := COALESCE(published_config,'{"schemaVersion":1,"filters":[]}');
    draft_config := COALESCE(draft_config,published_config);
    -- Add missing filters; retain existing labels, visibility, options and drafts.
    FOR node IN SELECT value FROM jsonb_array_elements(filters) LOOP
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(published_config->'filters') old WHERE old->'sources' ? (node->'sources'->>0)) THEN
        published_config := jsonb_set(published_config,'{filters}',(published_config->'filters') || jsonb_build_array(node));
      END IF;
      IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(draft_config->'filters') old WHERE old->'sources' ? (node->'sources'->>0)) THEN
        draft_config := jsonb_set(draft_config,'{filters}',(draft_config->'filters') || jsonb_build_array(node));
      END IF;
    END LOOP;
    next_revision := COALESCE(next_revision,1);
    INSERT INTO catalog_filter_configurations(organization_id,department,revision,draft,published) VALUES(d.organization_id,'naocare',next_revision,draft_config,published_config)
    ON CONFLICT(organization_id,department) DO UPDATE SET revision=EXCLUDED.revision,draft=EXCLUDED.draft,published=EXCLUDED.published,updated_at=now();
    INSERT INTO catalog_filter_versions(organization_id,department,revision,configuration) VALUES(d.organization_id,'naocare',next_revision,published_config);

    UPDATE brands SET name=CASE upper(name) WHEN 'TOM RICHARD' THEN 'Thom Richard' WHEN 'CRISTAN LAFAJET' THEN 'Christian Lafayette' WHEN 'GREY WOLF' THEN 'Grey Wolf' WHEN 'MATRIX' THEN 'Matrix' ELSE name END,version=version+1,updated_at=now()
    WHERE organization_id=d.organization_id AND department_id=d.id AND deleted_at IS NULL AND upper(name) IN ('TOM RICHARD','CRISTAN LAFAJET','GREY WOLF','MATRIX');
    IF NOT EXISTS(SELECT 1 FROM brands WHERE organization_id=d.organization_id AND department_id=d.id AND deleted_at IS NULL AND lower(name)='marc john') THEN
      INSERT INTO brands(organization_id,department_id,name,slug) VALUES(d.organization_id,d.id,'Marc John','marc-john') ON CONFLICT(organization_id,slug) WHERE deleted_at IS NULL DO NOTHING;
    END IF;
  END LOOP;
END;
$seed$;
