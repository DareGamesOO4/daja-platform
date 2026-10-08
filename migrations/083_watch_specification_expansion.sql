BEGIN;

-- Watch editor fields and answers only; product values and other departments stay intact.
DO $watch_specs$
DECLARE
  d record;
  item jsonb;
  spec_id uuid;
  existing_field jsonb;
  fields jsonb;
  config jsonb;
  group_item jsonb;
  seeds jsonb := $json$[
    {"slug":"materijal-kucista","name":"Materijal kućišta","options":["Metal","Nerđajući čelik","Polimer / smola","Titanijum"]},
    {"slug":"sirina-narukvice","name":"Širina narukvice","unit":"mm","type":"number","options":[]},
    {"slug":"duzina-narukvice","name":"Dužina narukvice","unit":"mm","type":"number","options":[]},
    {"slug":"tezina","name":"Težina","unit":"g","type":"number","options":[]},
    {"slug":"alarm","name":"Alarm","options":["Da","Ne"]},
    {"slug":"stoperica","name":"Štoperica","options":["Da","Ne"]},
    {"slug":"tajmer","name":"Tajmer","options":["Da","Ne"]},
    {"slug":"osvetljenje-displeja","name":"Osvetljenje displeja","options":["Da","Ne"]},
    {"slug":"svetsko-vreme","name":"Svetsko vreme","options":["Da","Ne"]},
    {"slug":"dvojno-vreme","name":"Dvojno vreme","options":["Da","Ne"]},
    {"slug":"12-24-casovni-format","name":"12/24-časovni format","options":["Da","Ne"]},
    {"slug":"satni-zvucni-signal","name":"Satni zvučni signal","options":["Da","Ne"]},
    {"slug":"luminescencija","name":"Luminescencija","options":["Kazaljke","Kazaljke i indeksi","Bez luminescencije"]},
    {"slug":"uzrasna-grupa","name":"Uzrasna grupa","options":["Odrasli","Deca"]}
  ]$json$::jsonb;
  additions jsonb := $json$[
    {"slug":"mehanizam","options":["2350","2039","6P23","6P27","6P29","JP11","JP27","MP23513A","MD21482"]},
    {"slug":"materijal-narukvice","options":["Polimer / smola","Titanijum"]},
    {"slug":"prikaz","options":["Analogno-Digitalni"]},
    {"slug":"boja-brojcanika","options":["Žuta","Providna","Kamuflažna"]},
    {"slug":"boja-kucista","options":["Bela","Plava","Zelena","Crvena","Roze","Ljubičasta","Narandžasta","Žuta","Braon","Bež","Providna","Kamuflažna"]},
    {"slug":"boja-narukvice","options":["Bela","Crvena","Ljubičasta","Narandžasta","Žuta","Bež","Providna","Kamuflažna"]}
  ]$json$::jsonb;
  layout jsonb := $json$[
    {"id":"general","name":"Opšti podaci","slugs":["uzrasna-grupa","serija","garancija","proizvo-ac"]},
    {"id":"mechanism","name":"Mehanizam","slugs":["tip-mehanizma","mehanizam","rezerva-snage"]},
    {"id":"functions","name":"Funkcije","slugs":["datum","dan-u-nedelji","hronograf","stoperica","alarm","tajmer","svetsko-vreme","dvojno-vreme","12-24-casovni-format","satni-zvucni-signal","osvetljenje-displeja"]},
    {"id":"design","name":"Dizajn","slugs":["stil","oblik","prikaz","boja-brojcanika","boja-kucista","luminescencija"]},
    {"id":"case","name":"Kućište i otpornost","slugs":["materijal-kucista","precnik-kucista","debljina-kucista","tezina","staklo","vodootpornost"]},
    {"id":"strap","name":"Narukvica","slugs":["materijal-narukvice","stil-narukvice","boja-narukvice","sirina-narukvice","duzina-narukvice"]}
  ]$json$::jsonb;
BEGIN
  FOR d IN SELECT id,organization_id FROM departments WHERE slug='satovi' AND deleted_at IS NULL LOOP
    -- Lock the saved configuration before editing; retain all existing applicability rules.
    INSERT INTO specification_editor_configurations(organization_id,department_id,configuration)
    VALUES(d.organization_id,d.id,'{"groups":[],"fields":[]}'::jsonb)
    ON CONFLICT DO NOTHING;
    SELECT configuration INTO config FROM specification_editor_configurations
    WHERE organization_id=d.organization_id AND department_id=d.id FOR UPDATE;

    FOR item IN SELECT value FROM jsonb_array_elements(seeds) LOOP
      INSERT INTO spec_keys(organization_id,department_id,department,name,slug,unit,data_type,option_values)
      VALUES(d.organization_id,d.id,'satovi',item->>'name',item->>'slug',item->>'unit',COALESCE(item->>'type','text'),item->'options')
      ON CONFLICT(organization_id,slug) WHERE deleted_at IS NULL DO NOTHING;
      SELECT id INTO spec_id FROM spec_keys WHERE organization_id=d.organization_id
        AND department_id=d.id AND slug=item->>'slug' AND deleted_at IS NULL;
      IF spec_id IS NULL THEN RAISE EXCEPTION 'Watch specification slug belongs to another department: %',item->>'slug'; END IF;
      UPDATE spec_keys s SET active=true,
        option_values=COALESCE(s.option_values,'[]'::jsonb) || COALESCE((
          SELECT jsonb_agg(v.value ORDER BY v.position)
          FROM jsonb_array_elements(item->'options') WITH ORDINALITY v(value,position)
          WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(s.option_values,'[]'::jsonb)) old
            WHERE lower(trim(old))=lower(trim(v.value #>> '{}')))
        ),'[]'::jsonb),version=version+1,updated_at=now()
      WHERE id=spec_id;
    END LOOP;

    FOR item IN SELECT value FROM jsonb_array_elements(additions) LOOP
      UPDATE spec_keys s SET option_values=COALESCE(s.option_values,'[]'::jsonb) || COALESCE((
        SELECT jsonb_agg(v.value ORDER BY v.position)
        FROM jsonb_array_elements(item->'options') WITH ORDINALITY v(value,position)
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(s.option_values,'[]'::jsonb)) old
          WHERE lower(trim(old))=lower(trim(v.value #>> '{}')))
      ),'[]'::jsonb),version=version+1,updated_at=now()
      WHERE organization_id=d.organization_id AND department_id=d.id AND slug=item->>'slug' AND deleted_at IS NULL;
    END LOOP;

    fields := '[]'::jsonb;
    FOR group_item IN SELECT value FROM jsonb_array_elements(layout) LOOP
      FOR item IN SELECT jsonb_build_object('slug',value,'order',position-1)
        FROM jsonb_array_elements_text(group_item->'slugs') WITH ORDINALITY v(value,position) LOOP
        SELECT id INTO spec_id FROM spec_keys WHERE organization_id=d.organization_id
          AND department_id=d.id AND slug=item->>'slug' AND deleted_at IS NULL AND active=true;
        IF spec_id IS NULL THEN CONTINUE; END IF;
        SELECT value INTO existing_field FROM jsonb_array_elements(COALESCE(config->'fields','[]'::jsonb))
          WHERE value->>'specId'=spec_id::text;
        fields := fields || jsonb_build_array(
          COALESCE(existing_field,jsonb_build_object('specId',spec_id,'visibility','[]'::jsonb,'options','[]'::jsonb))
          || jsonb_build_object('groupId',group_item->>'id','order',(item->>'order')::integer)
        );
      END LOOP;
    END LOOP;
    -- Keep custom fields and groups that are outside this requested layout.
    fields := fields || COALESCE((SELECT jsonb_agg(f.value) FROM jsonb_array_elements(COALESCE(config->'fields','[]'::jsonb)) f(value)
      WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(fields) n WHERE n->>'specId'=f.value->>'specId')),'[]'::jsonb);
    config := jsonb_set(config,'{groups}',
      (SELECT jsonb_agg(value-'slugs') FROM jsonb_array_elements(layout)) || COALESCE((
        SELECT jsonb_agg(g.value) FROM jsonb_array_elements(COALESCE(config->'groups','[]'::jsonb)) g(value)
        WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(layout) n WHERE n->>'id'=g.value->>'id')
      ),'[]'::jsonb));

    -- Explicit empty rules keep these new answers available to every watch for now,
    -- including calibers that would otherwise be inferred from existing product usage.
    FOR item IN SELECT value FROM jsonb_array_elements(additions) LOOP
      SELECT id INTO spec_id FROM spec_keys WHERE organization_id=d.organization_id
        AND department_id=d.id AND slug=item->>'slug' AND deleted_at IS NULL;
      fields := COALESCE((SELECT jsonb_agg(CASE WHEN f.value->>'specId'=spec_id::text THEN
        jsonb_set(f.value,'{options}',COALESCE(f.value->'options','[]'::jsonb) || COALESCE((
          SELECT jsonb_agg(jsonb_build_object('value',v.value,'rules','[]'::jsonb) ORDER BY v.position)
          FROM jsonb_array_elements_text(item->'options') WITH ORDINALITY v(value,position)
          WHERE NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(f.value->'options','[]'::jsonb)) old
            WHERE lower(trim(old->>'value'))=lower(trim(v.value)))
        ),'[]'::jsonb)) ELSE f.value END ORDER BY f.position)
        FROM jsonb_array_elements(fields) WITH ORDINALITY f(value,position)),'[]'::jsonb);
    END LOOP;
    UPDATE specification_editor_configurations SET configuration=jsonb_set(config,'{fields}',fields),
      version=version+1,updated_at=now() WHERE organization_id=d.organization_id AND department_id=d.id;
  END LOOP;
END;
$watch_specs$;

COMMIT;
