-- Apply after restoration/migration with -v apply=true; check with -v apply=false.
-- The operator creates the login and its private password before this owner runs.
\if :apply
BEGIN;
\else
BEGIN READ ONLY;
\endif

DO $$
DECLARE runtime_oid oid;
BEGIN
    SELECT oid INTO runtime_oid FROM pg_roles
    WHERE rolname = 'nexus_runtime' AND rolcanlogin
      AND NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls);
    IF runtime_oid IS NULL OR EXISTS (
        SELECT FROM pg_auth_members WHERE member = runtime_oid
    ) OR EXISTS (
        SELECT FROM pg_shdepend
        WHERE refclassid = 'pg_authid'::regclass AND refobjid = runtime_oid AND deptype = 'o'
    ) THEN
        RAISE EXCEPTION 'nexus_runtime must be a restricted login without memberships or ownership';
    END IF;
    IF current_database() <> 'nexus' OR current_user <> 'nexus' THEN
        RAISE EXCEPTION 'runtime grants require the nexus database and administrative owner';
    END IF;
    IF EXISTS (
        SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND c.relowner <> 'nexus'::regrole
          AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
    ) THEN
        RAISE EXCEPTION 'application relation ownership differs from nexus; inspect before granting';
    END IF;
END $$;

\if :apply
REVOKE ALL ON DATABASE nexus FROM PUBLIC;
GRANT CONNECT ON DATABASE nexus TO nexus_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public, paradedb TO nexus_runtime;
DO $$
DECLARE relation record;
BEGIN
    FOR relation IN
        SELECT c.relname, c.relkind FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
          AND NOT EXISTS (SELECT FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                          AND d.objid = c.oid AND d.deptype = 'e')
    LOOP
        IF relation.relkind = 'S' THEN
            EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO nexus_runtime', relation.relname);
        ELSE
            EXECUTE format('GRANT SELECT ON TABLE public.%I TO nexus_runtime', relation.relname);
            IF relation.relname <> 'alembic_version' THEN
                EXECUTE format('GRANT INSERT, UPDATE, DELETE ON TABLE public.%I TO nexus_runtime', relation.relname);
            END IF;
        END IF;
    END LOOP;
END $$;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON TABLE public.alembic_version FROM nexus_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE nexus IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexus_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE nexus IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO nexus_runtime;
\endif

DO $$
BEGIN
    IF NOT has_database_privilege('nexus_runtime', 'nexus', 'CONNECT')
       OR has_database_privilege('nexus_runtime', 'nexus', 'CREATE, TEMPORARY')
       OR EXISTS (SELECT FROM pg_namespace WHERE nspname NOT LIKE 'pg_temp_%'
                  AND has_schema_privilege('nexus_runtime', oid, 'CREATE'))
       OR NOT has_schema_privilege('nexus_runtime', 'public', 'USAGE')
       OR NOT has_schema_privilege('nexus_runtime', 'paradedb', 'USAGE')
       OR NOT has_table_privilege('nexus_runtime', 'public.alembic_version', 'SELECT')
       OR has_table_privilege('nexus_runtime', 'public.alembic_version',
                             'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
        RAISE EXCEPTION 'nexus_runtime database/schema/migration-ledger privileges differ';
    END IF;
    -- pg_search's reviewed helper only upserts its private typmod cache with a
    -- fixed search_path. Tokenizer casts use it; preserve that vendor boundary.
    IF EXISTS (
        SELECT FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname IN ('public', 'paradedb', 'pdb') AND p.prosecdef
          AND has_function_privilege('nexus_runtime', p.oid, 'EXECUTE')
          AND NOT (
              p.oid = 'paradedb._save_typmod(text[])'::regprocedure
              AND p.proowner = 'nexus'::regrole
              AND EXISTS (
                  SELECT FROM pg_depend d JOIN pg_extension e ON e.oid = d.refobjid
                  WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                    AND d.refclassid = 'pg_extension'::regclass AND d.deptype = 'e'
                    AND e.extname = 'pg_search' AND e.extversion = '0.26.2'
              )
          )
    ) THEN
        RAISE EXCEPTION 'runtime can execute an unreviewed security-definer function';
    END IF;
    IF has_table_privilege('nexus_runtime', 'paradedb._typmod_cache',
                           'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       OR has_sequence_privilege('nexus_runtime', 'paradedb._typmod_cache_id_seq', 'USAGE, UPDATE') THEN
        RAISE EXCEPTION 'runtime can mutate the extension tokenizer cache directly';
    END IF;
    IF EXISTS (
        SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
          AND has_table_privilege('nexus_runtime', c.oid, 'TRUNCATE, REFERENCES, TRIGGER')
    ) THEN
        RAISE EXCEPTION 'runtime table authority exceeds ordinary data operations';
    END IF;
END $$;
COMMIT;
