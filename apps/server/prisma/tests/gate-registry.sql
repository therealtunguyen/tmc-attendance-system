-- Run on a migrated test database with psql -v ON_ERROR_STOP=1 -f <this file>.
-- All fixtures and the assertion helper are rolled back, including after a disconnect.
BEGIN;

CREATE FUNCTION pg_temp.expect_gate_error(statement TEXT, expected_state TEXT) RETURNS void AS $$
BEGIN
    BEGIN
        EXECUTE statement;
    EXCEPTION WHEN OTHERS THEN
        IF SQLSTATE = expected_state THEN
            RETURN;
        END IF;
        RAISE;
    END;
    RAISE EXCEPTION 'Expected SQLSTATE %, but statement succeeded: %', expected_state, statement;
END;
$$ LANGUAGE plpgsql;

INSERT INTO "Edge" ("id", "name", "factoryId") VALUES
    ('__fr21_edge_bd', 'Test edge BD', '__fr21_bd'),
    ('__fr21_edge_la', 'Test edge LA', '__fr21_la');

INSERT INTO "Gate" ("id", "name", "factoryId", "edgeId", "location", "direction", "turnstileId") VALUES
    ('__fr21_gate_in', 'Test entrance', '__fr21_bd', '__fr21_edge_bd', 'Main entrance', 'IN', '__fr21_device_in'),
    ('__fr21_gate_out', 'Test exit', '__fr21_bd', '__fr21_edge_bd', 'Main exit', 'OUT', '__fr21_device_out');

DO $$
BEGIN
    IF (SELECT count(*) FROM "Gate" WHERE "edgeId" = '__fr21_edge_bd') <> 2 THEN
        RAISE EXCEPTION 'One edge must support multiple gates';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM "Gate" WHERE "id" = '__fr21_gate_in'
            AND "active" = true AND "createdAt" IS NOT NULL AND "updatedAt" IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'New gates need active and timestamp defaults';
    END IF;
END;
$$;

-- Required configuration, enum, and blank text constraints.
SELECT pg_temp.expect_gate_error($test$
    INSERT INTO "Gate" ("id", "name", "factoryId", "edgeId", "direction", "turnstileId")
    VALUES ('__fr21_bad', 'Test', '__fr21_bd', '__fr21_edge_bd', 'IN', '__fr21_bad_device')
$test$, '23502');

SELECT pg_temp.expect_gate_error($test$
    UPDATE "Gate" SET "direction" = 'BOTH' WHERE "id" = '__fr21_gate_in'
$test$, '22P02');

DO $$
DECLARE
    field_name TEXT;
BEGIN
    FOREACH field_name IN ARRAY ARRAY['id', 'name', 'factoryId', 'edgeId', 'location', 'turnstileId'] LOOP
        PERFORM pg_temp.expect_gate_error(
            format('UPDATE "Gate" SET %I = %L WHERE "id" = %L', field_name, E' \t\n ', '__fr21_gate_in'),
            '23514'
        );
        PERFORM pg_temp.expect_gate_error(
            format('UPDATE "Gate" SET %I = NULL WHERE "id" = %L', field_name, '__fr21_gate_in'),
            '23502'
        );
    END LOOP;
    FOREACH field_name IN ARRAY ARRAY['id', 'name', 'factoryId'] LOOP
        PERFORM pg_temp.expect_gate_error(
            format('UPDATE "Edge" SET %I = %L WHERE "id" = %L', field_name, E' \t\n ', '__fr21_edge_bd'),
            '23514'
        );
    END LOOP;
END;
$$;

-- One edge per factory and one registry entry per turnstile, across all factories.
SELECT pg_temp.expect_gate_error($test$
    INSERT INTO "Edge" ("id", "name", "factoryId")
    VALUES ('__fr21_edge_duplicate', 'Duplicate', '__fr21_bd')
$test$, '23505');

SELECT pg_temp.expect_gate_error($test$
    INSERT INTO "Gate" ("id", "name", "factoryId", "edgeId", "location", "direction", "turnstileId")
    VALUES ('__fr21_bad', 'Test', '__fr21_la', '__fr21_edge_la', 'Other factory', 'IN', '__fr21_device_in')
$test$, '23505');

-- The composite FK refuses both unknown edges and cross-factory assignments.
SELECT pg_temp.expect_gate_error($test$
    INSERT INTO "Gate" ("id", "name", "factoryId", "edgeId", "location", "direction", "turnstileId")
    VALUES ('__fr21_bad', 'Test', '__fr21_bd', '__fr21_unknown', 'Test', 'IN', '__fr21_bad_device')
$test$, '23503');

SELECT pg_temp.expect_gate_error($test$
    INSERT INTO "Gate" ("id", "name", "factoryId", "edgeId", "location", "direction", "turnstileId")
    VALUES ('__fr21_bad', 'Test', '__fr21_la', '__fr21_edge_bd', 'Test', 'IN', '__fr21_bad_device')
$test$, '23503');

SELECT pg_temp.expect_gate_error($test$
    UPDATE "Gate" SET "factoryId" = '__fr21_la' WHERE "id" = '__fr21_gate_in'
$test$, '23503');

SELECT pg_temp.expect_gate_error($test$
    UPDATE "Gate" SET "edgeId" = '__fr21_edge_la' WHERE "id" = '__fr21_gate_in'
$test$, '23503');

SELECT pg_temp.expect_gate_error($test$
    DELETE FROM "Edge" WHERE "id" = '__fr21_edge_bd'
$test$, '23503');

SELECT pg_temp.expect_gate_error($test$
    UPDATE "Edge" SET "factoryId" = '__fr21_new_factory' WHERE "id" = '__fr21_edge_bd'
$test$, '23503');

-- Deactivation preserves the gate ID and the attendance event that refers to it.
INSERT INTO "AttendanceEvent" ("id", "eventId", "gateId", "method", "outcome", "occurredAt")
VALUES ('__fr21_row', '__fr21_event', '__fr21_gate_in', 'MANUAL', 'GRANTED', CURRENT_TIMESTAMP);

UPDATE "Gate" SET "active" = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '__fr21_gate_in';
UPDATE "Gate" SET "active" = false, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = '__fr21_gate_in';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM "AttendanceEvent" AS e JOIN "Gate" AS g ON g."id" = e."gateId"
        WHERE e."eventId" = '__fr21_event' AND g."active" = false
    ) THEN
        RAISE EXCEPTION 'Deactivating a gate must retain it and its attendance history';
    END IF;
END;
$$;

SELECT pg_temp.expect_gate_error($test$
    INSERT INTO "Gate" ("id", "name", "factoryId", "edgeId", "location", "direction", "turnstileId")
    VALUES ('__fr21_bad', 'Test', '__fr21_la', '__fr21_edge_la', 'Other factory', 'IN', '__fr21_device_in')
$test$, '23505');

ROLLBACK;
